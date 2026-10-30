# karuku-codecs

[なんでもいっぱいめちゃくちゃ軽くするやつ](https://sirubedon.com/karuku/)（しるべどん屋）がブラウザで使っている変換エンジン（WebAssembly）の、**組み立て手順**です。

このサイトは LGPL のライブラリ（FFmpeg 5.1.10・LAME 3.100）を WebAssembly にして配っています。
LGPL では、ライブラリのソースに加えて「ビルドに使ったスクリプト」も受け取った人が手に入れられるようにする必要があるため、ここで公開しています。

## 中身

| 場所 | 内容 |
| --- | --- |
| `scripts/codecs/BUILD.md` | 再ビルドの手順（必要なツール、実行するコマンド） |
| `scripts/codecs/sources.lock.json` | 使ったソースの固定（Git コミット、ダウンロード URL と SHA-256） |
| `scripts/codecs/build-ffmpeg.sh` | FFmpeg の configure とリンク（動画用 ST/MT、音声用） |
| `scripts/codecs/build-audio-library.sh` | LAME・libogg・libvorbis のビルド |
| `scripts/codecs/build-libraries.mjs`・`build-avif.mjs` | 画像用（libwebp・libdeflate・zlib）と AVIF 用（libavif・libaom）のビルド |
| `scripts/codecs/image.c`・`avif.c` | 画像・AVIF 用 WASM の小さな入口（FFmpeg・LAME は含みません） |
| `codecs/licenses/` | 各ライブラリのライセンス本文・特許表示と、FFmpeg・LAME・libogg・libvorbis の実際の構成（`config.h` 類） |
| `codecs/manifest.json` | 配っているバイナリのハッシュ・サイズ・構成 |

## ソースについて

- **FFmpeg 5.1.10・LAME 3.100 は改変していません。** ソースは公式の配布物そのものです。
  - FFmpeg: https://ffmpeg.org/releases/ffmpeg-5.1.10.tar.xz （Git タグ `n5.1.10`、コミット `19feb712f5c1821d8a3fa1ad63c5bd2e3b9672eb`）
  - LAME: https://sourceforge.net/projects/lame/files/lame/3.100/
- FFmpeg の CLI 入口は ffmpeg.wasm の固定コミット `f876f907c7e9b9bf51d4ed0b913a855a63ae63fc` をそのまま使っています（https://github.com/ffmpegwasm/ffmpeg.wasm）。
- そのほかのライブラリの取得元とハッシュは `scripts/codecs/sources.lock.json` にあります。`bootstrap.mjs` が取得と照合をします。
- FFmpeg は `CONFIG_GPL=0`・`CONFIG_NONFREE=0`・`CONFIG_VERSION3=0` の LGPL 構成です。

## 注意

- スクリプトはアプリ本体のリポジトリ（非公開）の中で動かす前提で書かれています。
  出力先の `codecs/<種類>/` と `public/codecs/` は、ここではそのフォルダ構成だけを残しています。
  `BUILD.md` にあるソースの ZIP（`kururi-codec-sources.zip` 等）はここには置いていません。
  上の公式配布物と `sources.lock.json` の取得元から同じものが得られます。
- このリポジトリのスクリプト類の利用条件は設定していません（LGPL の対応物として公開しているものです）。各ライブラリはそれぞれのライセンスに従います。

問い合わせ：https://odaibako.net/u/qxoiUioxp
