#!/bin/bash
# 电台音生成器（离线，不联网）
# 用法：bash scripts/robot-voice.sh "词组1" "词组2" "词组3" ...
#   每个参数合成一段，词间自动留停顿，产物落 tmp/rv/radio_<时间戳>_<随机>.mp3
#   注意：shell 沙箱里 downloads 是只读的，产物只能落 tmp/；
#   send_audio 可以直接吃 tmp/rv/xxx.mp3 这个相对路径（已验证）
# 依赖：espeak-ng、ffmpeg、ffprobe
#
# 每次调用都会随机微调：语速、音高、词间停顿、频带、音量、轻微颤音，
# 所以同一句话两次念出来不会完全一样。想锁死某一档就显式给环境变量：
#   RV_SPEED=105 RV_PITCH=55 RV_GAP=0.16 RV_HP=330 RV_LP=3400 RV_VOL=2.2 bash scripts/robot-voice.sh "..."
# 随机范围都控制在"清晰档"内小幅浮动，不会糊。

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/tmp/rv"
mkdir -p "$WORK"
cd "$WORK"
OUTDIR="${OUTDIR:-$WORK}"

# 在 [min,max] 里取随机整数
rnd() { local lo=$1 hi=$2; echo $(( lo + RANDOM % (hi - lo + 1) )); }

SPEED="${RV_SPEED:-$(rnd 100 112)}"
PITCH="${RV_PITCH:-$(rnd 48 62)}"
AMP="${RV_AMP:-$(rnd 180 200)}"
HP="${RV_HP:-$(rnd 280 360)}"
LP="${RV_LP:-$(rnd 3300 3800)}"
VOL="${RV_VOL:-$(echo "$(rnd 20 24 | sed 's/^\(.\)/\1./')")}"
TREM_F="$(rnd 4 8)"
TREM_D="0.$(rnd 12 28)"

i=0
LIST=""
GAPFILES=""
for w in "$@"; do
  # 每个词音高再微扰 ±3，听起来像信号在飘
  P=$(( PITCH + $(rnd 0 6) - 3 ))
  espeak-ng -v cmn -s "$SPEED" -p "$P" -a "$AMP" -g 8 -w "w$i.wav" "$w" 2>/dev/null
  # 每个词后面跟一个长度随机的静音
  G="g$i.wav"
  GT="0.$(rnd 12 22)"
  ffmpeg -y -threads 1 -f lavfi -i anullsrc=r=22050:cl=mono -t "$GT" -q:a 9 "$G" >/dev/null 2>&1
  LIST="${LIST}file 'w$i.wav'\nfile '$G'\n"
  GAPFILES="$GAPFILES $G"
  i=$((i+1))
done

if [ "$i" -eq 0 ]; then
  echo "没给词组"
  exit 1
fi

printf "$LIST" > list.txt
ffmpeg -y -threads 1 -f concat -safe 0 -i list.txt -c copy joined.wav >/dev/null 2>&1
ffmpeg -y -threads 1 -i joined.wav \
  -af "highpass=f=$HP,lowpass=f=$LP,tremolo=f=$TREM_F:d=$TREM_D,volume=$VOL,alimiter=limit=0.95" \
  -ar 22050 -ac 1 out.wav >/dev/null 2>&1

STAMP=$(date +%s)
TARGET="$OUTDIR/radio_${STAMP}_$(rnd 100 999).mp3"
ffmpeg -y -threads 1 -i out.wav -b:a 96k "$TARGET" >/dev/null 2>&1
rm -f w*.wav $GAPFILES list.txt joined.wav out.wav

# 回显这次用的参数，方便排查"为什么这条不一样"
echo "参数 speed=$SPEED pitch=$PITCH amp=$AMP hp=$HP lp=$LP vol=$VOL trem=${TREM_F}/${TREM_D}"
ls -l "$TARGET"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$TARGET"
echo "$TARGET"
