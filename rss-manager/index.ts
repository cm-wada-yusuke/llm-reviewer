import { PubSub } from '@google-cloud/pubsub';
import * as RSSParser from 'rss-parser';
import type { Request, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';

const db = new Firestore({
  databaseId: 'rss-manager',
});
const parser = new RSSParser();

// Firestore のコレクション名
const COLLECTION_NAME = 'rss-feeds';

// RSS フィードの URL を Firestore に登録する HTTP 関数
export const rssRegister = async (req: Request, res: Response) => {
  const rssUrl = req.body.url;

  if (!rssUrl) {
    res.status(400).send('RSS URL is required.');
    return;
  }

  try {
    // Firestore に RSS URL を保存
    await db.collection(COLLECTION_NAME).add({
      url: rssUrl,
      lastCheckedGuid: null, // 初回は null を設定して新しい記事を全て検出する
    });
    res.status(200).send(`RSS URL added: ${rssUrl}`);
  } catch (error) {
    console.error('Error adding RSS URL:', error);
    res.status(500).send('Failed to add RSS URL.');
  }
};

const pubSubClient = new PubSub();
// Cloud Scheduler によって定期的に RSS フィードをチェックする関数
export const checkRssFeeds = async (event: any, context: any) => {
  try {
    // Firestore に登録された RSS フィードの URL を取得
    const snapshot = await db.collection(COLLECTION_NAME).get();
    if (snapshot.empty) {
      console.log('No RSS URLs found.');
    }

    // 各フィードを処理
    for (const doc of snapshot.docs) {
      const rssData = doc.data();
      const rssUrl = rssData.url;

      // RSS フィードを取得
      const feed = await parser.parseURL(rssUrl);

      // Firestore に保存された最後にチェックしたアイテムの GUID を取得
      const lastCheckedItemGuid = rssData.lastCheckedGuid;

      // 新しいアイテムを検出
      const newItems = feed.items.filter(
        (item) => item.guid !== lastCheckedItemGuid
      );

      if (newItems.length > 0) {
        // 新しいアイテムがあれば Pub/Sub に通知
        for (const item of newItems) {
          const messageBuffer = Buffer.from(
            JSON.stringify({
              title: item.title,
              link: item.link,
              pubDate: item.pubDate,
            })
          );
          // await pubSubClient.topic('rss-manager').publish(messageBuffer);
          console.log(`New item published to Pub/Sub: ${item.title}`);
        }

        // 最新のアイテムの GUID を Firestore に更新
        const latestItem = newItems[0];
        await doc.ref.update({ lastCheckedGuid: latestItem.guid });
      } else {
        console.log(`No new items for feed: ${rssUrl}`);
      }
    }
  } catch (error) {
    console.error('Error checking RSS feeds:', error);
    throw new Error('Failed to check RSS feeds');
  }
};
