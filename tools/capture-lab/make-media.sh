#!/bin/sh
# Regenerates media/*.mp4: the same 12 s pattern clip in several formats. Every 2 s the left 20% / middle 60% / right 20% rotate through
# red, green, blue (like tools/html-color-probe), so the lab can tell from a capture which colours should be on screen at a given time.
set -e
cd "$(dirname "$0")/media"
col() { case "$1" in R) echo 0xE62828;; G) echo 0x28C83C;; B) echo 0x2850E6;; esac; }
make() { # name width height encoder-args...
  name=$1; w=$2; h=$3; shift 3
  l=$(( w / 5 )); r=$(( w * 4 / 5 ))
  vf="color=c=black:s=${w}x${h}:r=25:d=12[base]"; chain="[base]"; n=0
  sets="RGB GBR BRG"
  for seg in 0 1 2 3 4 5; do
    set=$(echo $sets | cut -d' ' -f$(( seg % 3 + 1 ))); t0=$(( seg * 2 )); t1=$(( t0 + 2 ))
    for z in 0 1 2; do
      c=$(col $(echo $set | cut -c$(( z + 1 ))))
      case $z in 0) x=0; zw=$l;; 1) x=$l; zw=$(( r - l ));; 2) x=$r; zw=$(( w - r ));; esac
      n=$(( n + 1 ))
      vf="$vf;${chain}drawbox=x=$x:y=0:w=$zw:h=$h:color=$c:t=fill:enable='between(t,$t0,$t1)'[v$n]"; chain="[v$n]"
    done
  done
  ffmpeg -y -v error -filter_complex "$vf" -map "$chain" -an -g 25 -keyint_min 25 -sc_threshold 0 "$@" -movflags +faststart "$name.mp4"
  echo "$name: $(ffprobe -v error -show_entries stream=codec_name,profile,pix_fmt,width,height -of csv=p=0 $name.mp4) $(wc -c < $name.mp4) bytes"
}
make h264-720p 1280 720 -c:v libx264 -profile:v main -level 4.0 -pix_fmt yuv420p -crf 20
make h264-1080p 1920 1080 -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p -crf 20
make hevc-1080p-8bit 1920 1080 -c:v libx265 -pix_fmt yuv420p -tag:v hvc1 -crf 22 -x265-params log-level=error
make hevc-1080p-10bit 1920 1080 -c:v libx265 -profile:v main10 -pix_fmt yuv420p10le -tag:v hvc1 -crf 22 -x265-params log-level=error
