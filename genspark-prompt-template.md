# Genspark動画生成プロンプトのテンプレート

Instagram自動投稿の対象写真をGensparkの「AIビデオ」エージェントに渡すときは、
以下のポイントを必ず含めること(2026-09-07のテストで判明した注意点)。

## 必須ポイント

1. **料理の正式名称を明記する**
   写真ファイル名(拡張子を除いたもの)をそのまま「この料理の名前は『○○』です」と伝える。
   名称を伝えずに画像だけ渡すと、AIが写っていない食材(例: 「たらこ」)を勝手に
   追加して生成してしまうことがある。

2. **「写っていない食材を追加しない」「別の料理に見えないようにする」と明示的に指示する**
   例: 「写真に写っている食材以外は追加しないでください。別の料理に見えるような
   演出は避けてください。」

3. **15秒(2クリップ結合)ではなく10秒・単一クリップにする**
   モデルのデフォルト上限である10秒の単一クリップの方が、処理が軽く安定する。
   15秒(2クリップ結合)は生成時間が長く、ファイルサイズも大きくなる(約9.3MB→約2.6MB)。

4. **9:16の縦型(Instagram Reels向け)を指定する**

5. **BGM・音楽・効果音は一切つけないよう明示的に指示する**(2026-09-11追加)
   Gensparkに音楽込みで生成させると、意図しない変な音(鳥の鳴き声のような雑音等)が
   入ってしまうことがあった。動画につけるBGMは別途、著作権フリーの音源から
   投稿プログラム側(ffmpeg)で毎回ランダムに選んで自動的に合成する仕組みになっているため、
   Genspark側では無音(または映像のみ)で生成してもらうこと。

0. **渡す写真は、先に縦9:16に切り出したものにする**(2026-10-17追加、オーパスの調査より)
   写真は34枚ほぼ全部が横長。横長のまま9:16を頼むと、写っていない上下をAIが想像で描き足し、
   食器棚・厨房・お皿の取っ手などが出て崩れる。先に`node src/crop-vertical.js "photos\<写真名>.jpg"`で
   縦に切り出し(`generated/crop/<写真名>.jpg`ができる)、**その画像をGensparkにアップロードする**。
   料理の端が切れすぎるときは、第2引数(中心の位置0〜1。0.3なら左寄り、0.7なら右寄り)を変えて切り直す。
   どうしても料理が切れてしまう写真は、作り置きの対象から外して報告する。

6. **カメラワークは「アップロードした縦の写真を最初のコマにして、ゆっくり寄るだけ」の1カット**(2026-09-22追加、2026-10-16改訂、2026-10-17再改訂)
   2026-10-17の改訂: 「写真の構図に戻る」は往復の動きでカットを誘い、戻るときに外側を描き足す原因になるため削除。
   Gemini Omni Flashは、何も言わないと数カットの動画を作る仕様(Google公式)。1場面にするには
   「single continuous shot, no scene cuts」と明示する。冒頭の「動きのある瞬間から」も、別のつかみの場面を呼ぶ疑いがあるため削除。
   **写真より外側(写真に写っていないお皿のふち・テーブル)まで引かせない**。
   2026-10-16、「マッシュルームとベーコンのパスタ」(お皿のふちが切れたアップの写真)で、
   「お皿全体が映るところまで引く」と頼んだ結果、Gensparkが写っていない部分を想像で描き、
   5秒目で別の楕円のお皿・丸ごとのマッシュルームの別の料理に切り替わり、前半も横に引き伸ばされた
   崩れた動画になった。写真の外側を描かせると、AIは必ず作り話をする。

7. **途中で場面を切り替えない(カットなしの1つの映像)**(2026-10-16追加)
   「単一クリップ」と頼んでも、途中で別の場面につなぐことがある。「カットや場面の切り替えなし」と明記する。
   できた動画は`node src/check-video.js <動画>`で自動チェックする(下の「できた動画のチェック」)。

## プロンプト例

```
次のプロンプトを、言い換えたり演出を足したりせず、そのまま動画モデルに渡してください。料理名は「{dishName}」です。

In a single continuous shot with no scene cuts and no transitions, animate the uploaded vertical photo of "{dishName}". The uploaded photo is the exact first frame. The camera does one very slow, steady push-in toward the center of the dish for the whole clip, and nothing else. The only motion in the scene is gentle steam rising from the food (and a soft glisten of sauce). Keep the dish, the plating, the plate shape, the background and the lighting exactly as in the photo from the first frame to the last. Show only what is already visible in the photo.
Vertical 9:16, 10 seconds, one shot.
Audio: silence, no music.
Avoid: scene cuts, new camera angles, extra ingredients, extra props, utensils, hands, text.
```

- 冷たい料理(刺身・カルパッチョ・馬刺し・生ガキ・野菜スティックなど)は湯気が不自然なので、
  「The only motion in the scene is gentle steam…」の文を「The only motion is a soft shimmer of light on the surface.」に差し替える。
- 消したもの(2026-10-17): 「冒頭1〜2秒は動きのある瞬間から」、「最後に写真の構図まで戻る」、
  物の名前を挙げた打ち消し(「取っ手を付けない」など。名前を書くとかえって呼び込む説があるため)。

## できた動画のチェック(2026-10-16追加)

ダウンロードした動画は、保存・pushの前に必ずチェックする。

1. `node src/check-video.js <動画のパス> <写真のパス>` を実行する。機械で分かる崩れを見る(縦9:16か、長さ、途中で場面が切り替わっていないか)。
   あわせて、確認用の1枚絵(1秒ごとのコマを並べた画像)を`generated/check/`に作る。`NG`と出たら不合格
2. 1枚絵と元の写真を、目で(AIなら画像として読んで)見比べる。不合格にするのは、次のような場合:
   途中で別の場面に切り替わる、料理そのものが写真と別物(お皿の形や主役の盛り付けが違う)、引き伸ばし・ゆがみ・ノイズがある。
   (2026-10-17、たけしさんの判断: 背景に食器棚や厨房が多少入る、添え物が少し増える程度は合格)
3. 不合格なら`videos/`には入れない(pushしない)。やり直しは1回まで。2回だめならその写真はスキップして報告する

## 出力先

生成した動画は、写真と同じファイル名(拡張子だけ`.mp4`)で
`C:\Users\linka\Desktop\insta-auto-post\videos\` に保存する。
例: `photos/かつおだしの和風カルボナーラ.jpg` → `videos/かつおだしの和風カルボナーラ.mp4`

保存後は該当リポジトリでコミット・pushしておくこと
(`git add videos/... && git commit -m "..." && git push`)。
これにより、GitHub Actions側の自動投稿ワークフロー(月水金11:00 JST)が
この動画を優先して使用する(無い場合は投稿せずLINEに見送り通知が送られる)。
