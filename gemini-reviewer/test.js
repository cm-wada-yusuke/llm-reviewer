const fs = require('fs');

// 読み込むファイルのパス
const filePath = './html.html';

// ファイルを非同期で読み込む
fs.readFile(filePath, 'utf8', (err, data) => {
  if (err) {
    console.error('ファイルの読み込み中にエラーが発生しました:', err);
    return;
  }
  console.log(JSON.stringify(data));
});