#!/bin/sh
# Regenerates media/pattern.mp4 (progressive) and media/pattern-frag.mp4 (fragmented, for MSE).
# 1280x720, 12 s. Every 2 s the left 20% / centre 60% / right 20% rotate through red, green, blue,
# so the probe knows exactly which colour each zone must read back at a given currentTime.
set -e
cd "$(dirname "$0")/media"
R="230:40:40"; G="40:200:60"; B="40:80:230"
col() { case "$1" in R) echo 0xE62828;; G) echo 0x28C83C;; B) echo 0x2850E6;; esac; }
sets="RGB GBR BRG"
vf="color=c=black:s=1280x720:r=25:d=12[base]"
chain="[base]"; i=0; n=0
for seg in 0 1 2 3 4 5; do
  set=$(echo $sets | cut -d' ' -f$(( seg % 3 + 1 )))
  t0=$(( seg * 2 )); t1=$(( t0 + 2 ))
  for z in 0 1 2; do
    c=$(col $(echo $set | cut -c$(( z + 1 ))))
    case $z in 0) x=0; w=256;; 1) x=256; w=768;; 2) x=1024; w=256;; esac
    n=$(( n + 1 ))
    vf="$vf;${chain}drawbox=x=$x:y=0:w=$w:h=720:color=$c:t=fill:enable='between(t,$t0,$t1)'[v$n]"
    chain="[v$n]"
  done
done
common="-an -c:v libx264 -profile:v main -level 4.0 -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0 -crf 20"
ffmpeg -y -v error -filter_complex "$vf" -map "$chain" $common -movflags +faststart pattern.mp4
ffmpeg -y -v error -i pattern.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof pattern-frag.mp4
ffprobe -v error -show_entries stream=codec_name,profile,level,width,height -of csv=p=0 pattern.mp4
