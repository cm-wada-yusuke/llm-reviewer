import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import { WebClient } from '@slack/web-api';
import * as cheerio from 'cheerio';
import { PubsubMessage } from '@google-cloud/pubsub/build/src/publisher/pubsub-message';
import path = require('path');
import { Firestore } from '@google-cloud/firestore';

const projectId = process.env.PROJECT_ID;
const location = process.env.LOCATION;
const modelId = process.env.MODEL_ID;

// Vertex AI API のエンドポイント URL
const vertexAiEndpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${modelId}:generateContent`;

// Slackトークン（from Secret Manager）
const secretSlackToken = process.env.SLACK_TOKEN || '';

// 投稿するチャンネルID
const channelId = process.env.CHANNEL_ID || '';

// プロンプトを取得するためのFirestoreのコレクション名
const firestore = new Firestore({
  databaseId: 'rss-manager',
});

// Firestore のコレクション名
const collectionName = 'prompts';

type FeedItemType = {
  title: string;
  link: string;
  pubDate: string;
};
// Pub/Subのサブスクリション。届いたRSSのメタ情報をもとにGeminiでレビューする
export async function geminiReviewer(message: PubsubMessage) {
  const feedItemString = message.data
    ? Buffer.from(message.data as string, 'base64').toString()
    : null;

  if (!feedItemString) {
    return;
  }

  const feedItem: FeedItemType = JSON.parse(feedItemString) as FeedItemType;
  const contentUrl = feedItem.link;
  const bodyHtml = await parseBodyHtml(contentUrl);

  // レビューリクエスト用のデータ
  const llmRequestMediaPolicyBody = {
    contents: {
      role: 'user',
      parts: [
        {
          text: await getMediaPolicyPrompt(bodyHtml),
        },
      ],
    },
    generation_config: {
      temperature: 0.7, // 生成の多様性を調整 (0.0 - 1.0)
      max_output_tokens: 256, // 生成される最大トークン数
      top_p: 0.8, // トークン選択の多様性を調整
      top_k: 40, // 上位 K 個のトークンをサンプリング
    },
  };

  const llmRequestTypographyBody = {
    contents: {
      role: 'user',
      parts: [
        {
          text: await getTypographyPrompt(bodyHtml),
        },
      ],
    },
    generation_config: {
      temperature: 0.7, // 生成の多様性を調整 (0.0 - 1.0)
      max_output_tokens: 256, // 生成される最大トークン数
      top_p: 0.8, // トークン選択の多様性を調整
      top_k: 40, // 上位 K 個のトークンをサンプリング
    },
  };

  // 認証トークンの取得
  const auth = new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();

  // リクエストのオプションを設定
  const options = {
    method: 'POST', // リクエストメソッド
    body: JSON.stringify(llmRequestMediaPolicyBody),
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      'Content-Type': 'application/json',
    },
  };

  const typoGraphyOptions = {
    method: 'POST', // リクエストメソッド
    body: JSON.stringify(llmRequestTypographyBody),
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      'Content-Type': 'application/json',
    },
  };

  // Vertex AI API に対してリクエストを送信
  const mediaPolicyResponse = await fetch(vertexAiEndpoint, options);
  const mediaPolicyResponseJson: any = await mediaPolicyResponse.json();
  console.log(mediaPolicyResponseJson);
  const mediaPolicyResponseText =
    mediaPolicyResponseJson['candidates'][0]['content']['parts'][0]['text'];

  // Vertex AI API に対してリクエストを送信（誤字脱字チェック）
  const typographyResponse = await fetch(vertexAiEndpoint, typoGraphyOptions);
  const typographyResponseJson: any = await typographyResponse.json();
  console.log(typographyResponseJson);
  const typographyResponseText =
    typographyResponseJson['candidates'][0]['content']['parts'][0]['text'];

  // Slack クライアントを初期化
  const slackClient = new WebClient(secretSlackToken);

  // Slack チャンネルにメッセージを投稿する
  await slackClient.chat.postMessage({
    channel: channelId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*レビューした記事*\n${contentUrl}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📚 * ${modelId}によるメディアポリシーのレビュー*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: mediaPolicyResponseText,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📝 * ${modelId}による誤字脱字チェック*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: typographyResponseText,
        },
      },
    ],
  });

  return;
}

async function getMediaPolicyPrompt(html: string): Promise<string> {
  try {
    // rss-manager データベースの prompts コレクション、mediaPolicy ドキュメントの promptBody フィールドを取得
    const docRef = firestore.collection(collectionName).doc('mediaPolicy');
    const doc = await docRef.get();

    // ドキュメントが存在しない場合のエラーハンドリング
    if (!doc.exists) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody フィールドの値を取得
    const promptBody = doc.get('promptBody');

    // promptBody が存在するか確認
    if (promptBody === undefined) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody の値をレスポンスとして返す
    return `
    ${promptBody}

    "=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=" で囲まれている文章についてレビューしてください。
    
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
    ${html}
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
      `;
  } catch (error) {
    console.error('Error retrieving promptBody:', error);
    return '「エラーが発生しました」というテキストを返して下さい。';
  }
}

async function getTypographyPrompt(html: string): Promise<string> {
  try {
    // rss-manager データベースの prompts コレクション、typo ドキュメントの promptBody フィールドを取得
    const docRef = firestore.collection(collectionName).doc('typo');
    const doc = await docRef.get();

    // ドキュメントが存在しない場合のエラーハンドリング
    if (!doc.exists) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody フィールドの値を取得
    const promptBody = doc.get('promptBody');

    // promptBody が存在するか確認
    if (promptBody === undefined) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody の値をレスポンスとして返す
    return `
    ${promptBody}

    "=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=" で囲まれている文章についてレビューしてください。
    
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
    ${html}
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
      `;
  } catch (error) {
    console.error('Error retrieving promptBody:', error);
    return '「エラーが発生しました」というテキストを返して下さい。';
  }
}

async function parseBodyHtml(url: string): Promise<string> {
  const $ = await cheerio.fromURL(url);
  return $('body div.znc').html() || '';
}
