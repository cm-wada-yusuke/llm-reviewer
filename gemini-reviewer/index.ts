import { GoogleAuth } from 'google-auth-library';
import fetch from 'node-fetch';
import { WebClient } from '@slack/web-api';
import * as cheerio from 'cheerio';
import { PubsubMessage } from '@google-cloud/pubsub/build/src/publisher/pubsub-message';
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
  const contentTitle = feedItem.title;
  const bodyHtml = await parseBodyHtml(contentUrl);

  // レビューリクエスト用のデータ
  const agenda = await getMediaPolicyPrompt(
    bodyHtml,
    'メディアポリシーに対する全体的な評価を行ってください'
  );
  const fix = await getMediaPolicyPrompt(
    bodyHtml,
    'メディアポリシーに対する問題箇所の指摘と改善案を出してください'
  );
  const good = await getMediaPolicyPrompt(
    bodyHtml,
    'メディアポリシーに沿った良い点を記載してください'
  );
  const [agendaBody, fixBody, goodBody] = [agenda, fix, good].map((prompt) => ({
    contents: {
      role: 'user',
      parts: [
        {
          text: prompt,
        },
      ],
    },
    generation_config: {
      temperature: 0.7, // 生成の多様性を調整 (0.0 - 1.0)
      max_output_tokens: 1000, // 生成される最大トークン数
      top_p: 0.8, // トークン選択の多様性を調整
      top_k: 40, // 上位 K 個のトークンをサンプリング
    },
  }));

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
      max_output_tokens: 1000, // 生成される最大トークン数
      top_p: 0.8, // トークン選択の多様性を調整
      top_k: 40, // 上位 K 個のトークンをサンプリング
    },
  };

  // 認証トークンの取得
  const auth = new GoogleAuth({
    scopes: 'https://www.googleapis.com/auth/cloud-platform',
  });
  const client = await auth.getClient();
  const accessToken = (await client.getAccessToken()).token || '';

  // Vertex AI にリクエストを送信
  const mediaPolicyAgenda = await fetchVertexAi(accessToken, agendaBody);
  const mediaPolicyFix = await fetchVertexAi(accessToken, fixBody);
  const mediaPolicyGood = await fetchVertexAi(accessToken, goodBody);
  const typo = await fetchVertexAi(accessToken, llmRequestTypographyBody);

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
          text: `*レビューした記事*\n <${contentUrl}|${contentTitle}>`,
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
          text: '*全体的な評価*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: mediaPolicyAgenda,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*問題開所の指摘と改善案*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: mediaPolicyFix,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*メディアポリシーに沿った良い点*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: mediaPolicyGood,
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
          text: typo,
        },
      },
    ],
  });

  return;
}

async function getMediaPolicyPrompt(
  html: string,
  context: string
): Promise<string> {
  try {
    // rss-manager データベースの prompts コレクション、mediaPolicy ドキュメントの promptBody フィールドを取得
    const docRef = firestore.collection(collectionName).doc('mediaPolicy');
    const doc = await docRef.get();

    const outputRef = firestore.collection(collectionName).doc('output');
    const outputDoc = await outputRef.get();

    // ドキュメントが存在しない場合のエラーハンドリング
    if (!doc.exists || !outputDoc.exists) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody フィールドの値を取得
    const promptBody = doc.get('promptBody');
    const outputBody = outputDoc.get('promptBody');

    // promptBody が存在するか確認
    if (promptBody === undefined || outputBody === undefined) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody の値をレスポンスとして返す
    const prompt = `
    ${promptBody}

    ${context}

    ${outputBody}

    "=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=" で囲まれている文章についてレビューしてください。
    
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
    ${html}
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
      `;
    console.log(prompt);
    return prompt;
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

    const outputRef = firestore.collection(collectionName).doc('output');
    const outputDoc = await outputRef.get();

    // ドキュメントが存在しない場合のエラーハンドリング
    if (!doc.exists || !outputDoc.exists) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody フィールドの値を取得
    const promptBody = doc.get('promptBody');
    const outputBody = outputDoc.get('promptBody');

    // promptBody が存在するか確認
    if (promptBody === undefined || outputBody === undefined) {
      return '「プロンプトが見つかりませんでした」というテキストを返して下さい。';
    }

    // promptBody の値をレスポンスとして返す
    const prompt = `
    ${promptBody}

    ${outputBody}

    "=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=" で囲まれている文章についてレビューしてください。
    
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
    ${html}
    =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
      `;

    console.log(prompt);
    return prompt;
  } catch (error) {
    console.error('Error retrieving promptBody:', error);
    return '「エラーが発生しました」というテキストを返して下さい。';
  }
}

async function parseBodyHtml(url: string): Promise<string> {
  const $ = await cheerio.fromURL(url);
  return $('body div.znc').html() || '';
}

async function fetchVertexAi(
  accessToken: string,
  geminiRequestBody: any
): Promise<string> {
  const option = {
    method: 'POST', // リクエストメソッド
    body: JSON.stringify(geminiRequestBody),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  const response = await fetch(vertexAiEndpoint, option);
  const responseJson: any = await response.json();
  console.log({ responseJson: JSON.stringify(responseJson['candidates']) });
  const text = responseJson['candidates'][0]['content']['parts'][0]['text'];
  console.log({ responseText: text });
  return text;
}
