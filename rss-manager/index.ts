import { PubSub } from '@google-cloud/pubsub';
import * as RSSParser from 'rss-parser';
import type { Request, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';

const db = new Firestore({
  databaseId: 'rss-manager',
});
const parser = new RSSParser();

// Firestore のコレクション名
const collectionName = 'rss-feeds';

// RSS フィードの URL を Firestore に登録する HTTP 関数
export const rssRegister = async (req: Request, res: Response) => {
  const rssUrl = req.body.url;

  if (!rssUrl) {
    res.status(400).send('RSS URL is required.');
    return;
  }

  try {
    // Firestore に RSS URL を保存
    await db.collection(collectionName).add({
      url: rssUrl,
      lastCheckedGuid: null, // 初回は null を設定して新しい記事を全て検出する
    });
    res.status(200).send(`RSS URL added: ${rssUrl}`);
  } catch (error) {
    console.error('Error adding RSS URL:', error);
    res.status(500).send('Failed to add RSS URL.');
  }
};

// Cloud Scheduler によって定期的に RSS フィードをチェックする関数
const pubSubClient = new PubSub();
export const checkRssFeeds = async (req: Request, res: Response) => {
  try {
    // Firestore に登録された RSS フィードの URL を取得
    const snapshot = await db.collection(collectionName).get();
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
      const lastIndex = (() => {
        if (!lastCheckedItemGuid) {
          return feed.items.length;
        } else {
          return feed.items.findIndex(
            (item) => item.guid === lastCheckedItemGuid
          );
        }
      })();
      const newItems = feed.items.slice(0, Math.max(0, lastIndex));

      if (newItems.length > 0) {
        // 新しいアイテムがあれば Pub/Sub に通知
        for (const item of newItems) {
          const message = {
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
          };
          await pubSubClient
            .topic('rss-updates')
            .publishMessage({ json: message });
          console.log(`New item published to Pub/Sub: ${item.title}`);
        }

        // 最新のアイテムの GUID を Firestore に更新
        const latestItem = newItems[0];
        await doc.ref.update({ lastCheckedGuid: latestItem.guid });
        res
          .status(200)
          .send(`Items published to Pub/Sub: lastItem: ${latestItem.title}`);
      } else {
        console.log(`No new items for feed: ${rssUrl}`);
        res.status(200).send(`No new items for feed: ${rssUrl}`);
      }
    }
  } catch (error) {
    console.error('Error checking RSS feeds:', error);
    res.status(200).send('Error checking RSS feeds');
    throw new Error('Failed to check RSS feeds');
  }
};
