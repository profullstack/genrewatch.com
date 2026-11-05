#!/bin/sh
# Renders the launcher icons, TV banner and Amazon Appstore art from the site's own
# artwork in store/src (copied from apps/web/public). Runs inside alpine:
#   docker run --rm -v "\$PWD/appstores/firetv:/w" -w /w alpine:3.20 sh store/render.sh
set -eu
apk add --no-cache imagemagick >/dev/null
R=app/src/main/res
O=store/out
mkdir -p "$O" "$R/mipmap-xhdpi" "$R/mipmap-xxhdpi" "$R/drawable-xhdpi"

# Icons keep their transparency; the Appstore allows it and a launcher wants it.
magick store/src/mark.png -resize 96x96 "$R/mipmap-xhdpi/ic_launcher.png"
magick store/src/mark.png -resize 144x144 "$R/mipmap-xxhdpi/ic_launcher.png"
magick store/src/mark.png -resize 512x512 "$O/icon-512.png"
magick store/src/mark.png -resize 114x114 "$O/icon-114.png"

# Fire TV art may not carry transparency, so the lockup is flattened onto the
# site's own night blue.
magick store/src/wordmark.png -resize 760x "$O/.wordmark.png"
magick -size 1280x720 xc:'#12161f' "$O/.wordmark.png" -gravity west -geometry +120+0 -composite \
  -font DejaVu-Sans -pointsize 42 -fill '#00cdff' -annotate +126+520 'know before it drops' \
  -alpha remove -alpha off "$O/firetv-icon-1280x720.png"
magick -size 320x180 xc:'#12161f' \( store/src/wordmark.png -resize 270x \) -gravity center -composite \
  -alpha remove -alpha off "$R/drawable-xhdpi/banner.png"
magick -size 1920x1080 xc:'#12161f' \( store/src/mark.png -resize 620x620 -alpha set -channel A -evaluate multiply 0.16 +channel \) \
  -gravity east -geometry +180+0 -composite -alpha remove -alpha off "$O/firetv-background-1920x1080.png"
rm -f "$O/.wordmark.png"

[ -n "${OWNER:-}" ] && chown -R "$OWNER" "$R" "$O"
ls -l "$O"
