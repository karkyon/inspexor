#!/usr/bin/env bash
# CHG-006: 結合試験用の Firestore エミュレータを 127.0.0.1:8085 で起動する（起動済みなら何もしない）。
# Cloud Shell で未導入なら apt で導入する（Cloud Shell の再起動で消えるため毎回確認）。
set -euo pipefail
HOSTPORT="127.0.0.1:8085"
if (echo > /dev/tcp/127.0.0.1/8085) 2>/dev/null; then echo "Firestore エミュレータ起動済み（$HOSTPORT）"; exit 0; fi
if ! gcloud emulators firestore start --help > /dev/null 2>&1 || ! ls /usr/lib/google-cloud-sdk/platform/cloud-firestore-emulator > /dev/null 2>&1; then
  echo "Firestore エミュレータを導入します（apt）"
  sudo apt-get install -y -qq google-cloud-cli-firestore-emulator > /tmp/ix-fs-emu-install.log 2>&1 || { tail -5 /tmp/ix-fs-emu-install.log; exit 1; }
fi
nohup gcloud emulators firestore start --host-port="$HOSTPORT" --quiet > /tmp/firestore-emulator.log 2>&1 &
for i in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/8085) 2>/dev/null && break; sleep 1; done
(echo > /dev/tcp/127.0.0.1/8085) 2>/dev/null || { echo "エミュレータが起動しません:"; tail -20 /tmp/firestore-emulator.log; exit 1; }
echo "Firestore エミュレータ起動（$HOSTPORT）"
