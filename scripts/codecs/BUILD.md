# 専用WASMの再ビルド

配布済みのバイナリは `codecs/`、Cソースとビルド手順はこのディレクトリです。
`sources.lock.json` がソースのGitコミットとダウンロードのSHA-256を固定します。
`codecs/manifest.json` に完成したバイナリのハッシュ・サイズ・設定を記録し、
起動時に `scripts/prepare-codecs.mjs` が検証して `public/codecs/` にコピーします。
通常の `npm ci && npm run dev` にはコンパイラーは不要です。

## 必要なツール

- Node.js 22.12以降、Git、curl、tar、GNU make、pkg-config。
- AVIF用にCMake 3.31.6、Ninja 1.13.2、Perl。WindowsではGit付属Perlも利用できます。
- Emsdkコミット `96c657fc60920d2a6a82318aa50e0abf82749604` を取得し、
  `emsdk install 3.1.40`、`emsdk activate 3.1.40` を実行します。
- WindowsではMSYS2のbash・make・pkgconfを使います。Emsdk付属Pythonは
  `python/3.13.3_64bit/python.exe` を使います。グローバルのPATH変更は不要です。
- MSYS2内でも `node --version` が実行できるようにしてください。標準のWindows版Node.jsなら、そのシェル内だけで `export PATH="/c/Program Files/nodejs:$PATH"` と設定できます。
- Linux/macOSではbashとpython3を使います。今回実際にビルドした環境は
  Windows、MSYS2 20260927、Emscripten 3.1.40です。他OSでの再ビルドは未検証です。

Emsdkの取得例（既存の作業ディレクトリとは別に用意）：

```sh
git clone https://github.com/emscripten-core/emsdk.git emsdk
git -C emsdk checkout 96c657fc60920d2a6a82318aa50e0abf82749604
cd emsdk
./emsdk install 3.1.40
./emsdk activate 3.1.40
cd ..
```

## 実行

WindowsのMSYS2 bashでは、プロジェクトから以下を実行します。
SDKは先に用意したディレクトリを指定します。作業ディレクトリは任意の新しい場所です。

```sh
bash scripts/codecs/build-all.sh /d/codec-build /d/emsdk
```

順番は、固定したソースの取得と照合 → 画像ライブラリと画像WASM →
AVIF用libaom・libavifとAVIF WASM →
動画用STライブラリとFFmpeg → 動画用MTライブラリとFFmpeg →
音声用LAME・libogg・libvorbisとFFmpeg →
ライセンス・構成のコピー → マニフェスト更新 → アプリ用のコピーです。
同じ作業ディレクトリで複数のビルドを同時に実行しないでください。
FFmpegの構成は毎回configureし、機能一覧を変えたときも古い設定を再利用しません。
ソース・SDKを変える場合は、新しい作業ディレクトリを使います。

個別のコマンドは `build-all.sh` にあります。ライブラリのキャッシュは
Cファイルの時刻だけでなく、コンパイルオプションと全ヘッダーも照合します。
完成後は `npm test`、`npm run build`、ローカルの `checks.html` と
`codec-checks.html` と `animation-checks.html` と `avif-checks.html` で実バイナリを確認します。

対応ソースは `codecs/kururi-codec-sources.zip`（約25.2MB）と `codecs/kururi-avif-sources.zip`（約19.5MB）です。両方取得してください。ネットワークから
ソースを取得しない場合、ZIP中のupstreamアーカイブをビルド作業ディレクトリのsourcesへ展開します。
Gitアーカイブにはディレクトリ接頭辞がないので、ffmpeg・ffmpeg-wasm・libavif・aomの
ディレクトリをそれぞれ作って中へ展開します。その他のアーカイブは元の名前のディレクトリを含みます。
この場合、固定ソースをGitで確認するbootstrapを省き、build-all.shの
build-libraries.mjs・build-avif.mjs・build-audio-library.sh・build-ffmpeg.shの個別コマンドを順番に実行します。
修正したソースからも同じ手順でリンクできます。SDKは別途用意してください。

## 構成

| 用途 | 実サイズ | 初期WASMメモリ | スレッド |
| --- | ---: | ---: | ---: |
| 画像用 libwebp + libdeflate | 706,584 B | 16 MiB | 1/Worker |
| AVIF用 libavif + libaom | 9,104,674 B | 32 MiB | 1/Worker |
| 動画用FFmpeg ST | 4,064,001 B | 32 MiB | 1/Worker |
| 動画用FFmpeg MT | 4,174,894 B | 128 MiB | 2 |
| 音声用FFmpeg + LAME + Vorbis | 2,200,750 B | 32 MiB | 1/Worker |

メモリは必要に応じて最大1GiBまで増えます。上記はWASMヒープの初期量で、
実際の端末全体のメモリ使用量ではありません。JS・描画・入力・出力は別に使います。
MTの `PTHREAD_POOL_SIZE=2` は常駐する子Worker数で、CPU使用数や速度の保証ではありません。

画像・FFmpeg用ライブラリは `-O3 -flto -msimd128 -msse2`、MTは `-pthread` も使います。
AVIF用は `-O3 -flto -msimd128 -DNDEBUG`。libaomはgeneric CPU・1スレッド・AV1エンコーダーとデコーダーのみで、ツール・例・テスト・動的CPU判定は含めません。
libavifはAOMだけを使い、他のAV1コーデックや外部libyuv/libsharpyuvはリンクしません。libavifが内包するスカラーlibyuvの拡縮コードは含まれます。
FFmpegの全オプションと有効なデコーダー・フィルターは `build-ffmpeg.sh` と
`codecs/licenses/ffmpeg-{st,mt,audio}-config.h` と `ffmpeg-{st,mt,audio}-config-components.h` で確認できます。
動画の再出力・字幕・フォント・ネットワーク入力・GPLの外部エンコーダーは含めません。
PNG/APNG/GIF/WebP出力と、限定した動画入力のデコーダーを残しています。
AVIはコンテナのため、中の映像コーデックも有効である必要があります。
2026-10-04のAVI不具合対応では、削っていたUt Video・Lagarith・MagicYUVを戻しました。
Ut Videoは透過と音声付きの人工AVIで、通常版・MT版からWebPへの変換を確認しました。
Lagarith・MagicYUVはビルドで有効化しましたが、個別の実変換は未検証です。
FFmpeg本体は無改変の n5.1.10、CLI入口は固定したffmpeg.wasmの `src/fftools` と `src/bind` です。

音声用はLAME 3.100・libogg 1.3.6・libvorbis 1.3.7の静的ライブラリをリンクした独立したFFmpegです。画像や動画のみの処理ではロードしません。
MP3・AAC・PCM/ADPCM・FLAC・ALAC・Vorbis・Opus・WMA1/2をデコードし、MP3かOGG（Vorbis）に保存します。
demuxerはmp3/aac/wav/flac/ogg/mov/matroska/aiff/asf、filterは音声用buffer/aformat/aresample/trim等です。
音声用コアもネットワーク入力・動画出力・GPL機能は含みません。入力はWORKERFSで参照し、全体の並列数に含めます。
LAMEのCLIとMP3デコーダーはビルドせず、デコードはFFmpegが担当します。追加ライブラリも無改変の公式tarballです。
COPYING・LICENSE・READMEと実際のconfig.hを `codecs/licenses/` に同梱します。

音声だけのビルド（固定ソースをbootstrapで準備してから）：

```sh
bash scripts/codecs/build-audio-library.sh /d/codec-build /d/emsdk
bash scripts/codecs/build-ffmpeg.sh /d/codec-build /d/emsdk audio
```

完成後はprepare-notices.mjs→update-manifest.mjs→package-sources.mjs→prepare-codecs.mjsを実行します。
`npm test` の audio-wasm.test.mjsは配布する実WASMで9形式の入力・MP3とVorbisの相互変換・低ビットレートとモノラルを確認します。

画像用の `image.c` はFSを持たず、RGBA・WebP・deflateを扱います。
PNG Subフィルターと画素の完全一致判定に明示的な128bit SIMDを使い、
libwebpのSSE2経路もWASM SIMDへコンパイルします。

既存APNG/GIFの圧縮はImageDecoderで合成済みのコマを読み、同じ画像Workerで保存します。
非対応環境ではFFmpegでPNG連番を取り出し、元の表示時間を記録したJSONから再構築します（600コマまで）。
アニメWebPは画像WASMのlibwebpで読みます。いずれも動画FPSへ変換せず、コマの表示時間を保持します。
ImageDecoderのAPIは[WebCodecs仕様](https://www.w3.org/TR/webcodecs/#imagedecoder-interface)を参照しています。

AVIF用の `avif.c` はFSを持たず、RGBAをlibavif/libaomで保存・読み込みます。AVIF利用時だけロードします。
画質は1〜100、fastはspeed10、thoroughはspeed6。色は通常YUV420、losslessではYUV444＋identity、アルファは常にlosslessで保存します。
表示時間は1MHzのtimescale、アプリの総再生回数0は無限、1以上はlibavifのrepetitionCountに1を引いて渡します。
動画からAVIFへはFFmpegでPNG連番を作り、画像WorkerのAVIFエンコーダーへ渡します。動画入力の機能は削っていません。

AVIFだけを再ビルドする場合：

```sh
node scripts/codecs/build-avif.mjs --work D:/codec-build --emsdk D:/emsdk --cmake /path/to/cmake --ninja /path/to/ninja --perl /path/to/perl
```

Windowsの実ビルドはPythonのpipでCMake/Ninjaを作業ディレクトリだけに導入し、Git付属Perlを指定しました。
必要に応じて `python -m pip install --target TOOL_DIRECTORY cmake==3.31.6 ninja==1.13.2` を使い、CMakeは `TOOL_DIRECTORY/cmake/data/bin/cmake.exe`、Ninjaは `TOOL_DIRECTORY/bin/ninja.exe` です。
作業ディレクトリの `avif-build-options.json` に実構成を記録します。Cの変更だけなら `--link-only 1` で既にビルドしたライブラリを使えます。
完成後はprepare-notices.mjs→update-manifest.mjs→package-sources.mjs→prepare-codecs.mjsも実行し、バイナリと公開ソースを一致させてください。
公開ソースZIPは[Workers Static Assetsの1ファイル25MiB制限](https://developers.cloudflare.com/workers/platform/limits/#static-assets)に合わせて2本に分けます。

## 配布物とソース

FFmpegのこの構成は `CONFIG_GPL=0`、`CONFIG_NONFREE=0`、`CONFIG_VERSION3=0` です。
ライセンス本文・帰属・パテント文書・実際の構成を `codecs/licenses/` に保持します。
依存物の条件はプロジェクトの `THIRD_PARTY_NOTICES.md` を参照してください。
エンジンのソースを変更した場合も、変更したソース・ビルドスクリプト・固定した依存物を
バイナリと一緒に公開できるように保持します。アプリ全体のライセンスは未決定です。

Cloudflare Workers Static Assets用の `public/_headers` はページとWorkerに
COOP/COEPを付けます。MTはSharedArrayBufferとブラウザのcross-origin isolationが必要です。
条件を満たさない端末やMTの読み込みに失敗した場合はSTを使います。
変換自体はブラウザ内で行います。Cloudflareの実環境への配備・動作確認は今回行っていません。
