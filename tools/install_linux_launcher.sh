#!/bin/sh
# Adds "Distortion Lab" and "Distortion Lab (with Claude)" to the Linux applications menu (and the desktop, if present).
# Run once from the distortion-lab folder:  sh tools/install_linux_launcher.sh
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
make_entry() {  # name, script, file
  cat > "$3" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$1
Comment=Percept-matching laboratory app
Exec=sh -c 'cd "$DIR" && ./$2; echo; echo "Press Return to close."; read x'
Terminal=true
Categories=Science;Education;
DESKTOP
  chmod +x "$3"
}
make_entry "Distortion Lab" "start.sh" "$APPS/distortion-lab.desktop"
make_entry "Distortion Lab (with Claude)" "start-with-claude.sh" "$APPS/distortion-lab-claude.desktop"
for d in "$HOME/Desktop" "$(xdg-user-dir DESKTOP 2>/dev/null || true)"; do
  if [ -n "$d" ] && [ -d "$d" ]; then
    cp "$APPS/distortion-lab.desktop" "$APPS/distortion-lab-claude.desktop" "$d/"
    chmod +x "$d/distortion-lab.desktop" "$d/distortion-lab-claude.desktop"
    command -v gio >/dev/null 2>&1 && gio set "$d/distortion-lab.desktop" metadata::trusted true 2>/dev/null || true
    command -v gio >/dev/null 2>&1 && gio set "$d/distortion-lab-claude.desktop" metadata::trusted true 2>/dev/null || true
    break
  fi
done
echo "Installed. Look for 'Distortion Lab' in the applications menu (and on the desktop)."
echo "Tip: to open the app in Chrome/Chromium (needed for the MIDI controller), set it as the default browser,"
echo "or start with:  BROWSER=google-chrome ./start.sh   (or chromium)"
