#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=:0
export HOME=/root
export XDG_RUNTIME_DIR=/tmp/xdg-runtime
export CHROME_USER_DATA_DIR=/tmp/chrome-profile
export CHROME_DEBUGGING_PORT=9222
export DESKTOP_USER=desktop
export DESKTOP_HOME=/home/desktop
export DESKTOP_XAUTHORITY=/tmp/desktop.Xauthority
export DESKTOP_ICEAUTHORITY=/tmp/desktop.ICEauthority
export STARTXFCE_LOG_PATH=/tmp/startxfce4.log

mkdir -p "${XDG_RUNTIME_DIR}" "${CHROME_USER_DATA_DIR}"
chmod 700 "${XDG_RUNTIME_DIR}"
touch "${DESKTOP_XAUTHORITY}" "${DESKTOP_ICEAUTHORITY}"
chown "${DESKTOP_USER}:${DESKTOP_USER}" \
  "${XDG_RUNTIME_DIR}" \
  "${CHROME_USER_DATA_DIR}" \
  "${DESKTOP_XAUTHORITY}" \
  "${DESKTOP_ICEAUTHORITY}"

/usr/local/bin/sandbox-api &
sandbox_api_pid=$!

cleanup() {
  for pid in \
    "${chrome_launcher_pid:-}" \
    "${chrome_pid:-}" \
    "${websockify_pid:-}" \
    "${x11vnc_pid:-}" \
    "${xfce_launcher_pid:-}" \
    "${xfce_pid:-}" \
    "${xvfb_pid:-}" \
    "${sandbox_api_pid:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" || true
    fi
  done
}

resolve_browser_binary() {
  local candidate=""

  for candidate in google-chrome-stable chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "Could not find a Chromium-based browser binary." >&2
  exit 1
}

wait_for_file() {
  local file_path="$1"
  local attempt=0

  until [[ -e "${file_path}" ]]; do
    attempt=$((attempt + 1))

    if (( attempt > 200 )); then
      echo "Timed out waiting for ${file_path}" >&2
      exit 1
    fi

    sleep 0.1
  done
}

wait_for_user_process() {
  local pattern="$1"
  local timeout_attempts="${2:-100}"
  local attempt=0
  local pid=""

  until [[ -n "${pid}" ]]; do
    pid="$(pgrep -u "${DESKTOP_USER}" -n -f -- "${pattern}" || true)"

    if [[ -n "${pid}" ]]; then
      printf '%s\n' "${pid}"
      return 0
    fi

    attempt=$((attempt + 1))

    if (( attempt > timeout_attempts )); then
      return 1
    fi

    sleep 0.1
  done
}

start_browser() {
  local browser_binary
  local browser_command

  browser_binary="$(resolve_browser_binary)"
  browser_command="$(cat <<EOF
export DISPLAY=${DISPLAY}
export HOME=${DESKTOP_HOME}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
export XAUTHORITY=${DESKTOP_XAUTHORITY}
export ICEAUTHORITY=${DESKTOP_ICEAUTHORITY}
exec "${browser_binary}" \
  --user-data-dir="${CHROME_USER_DATA_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${CHROME_DEBUGGING_PORT}" \
  --window-size=1440,900 \
  about:blank
EOF
)"

  su -s /bin/bash -c "${browser_command}" "${DESKTOP_USER}" >/tmp/google-chrome.log 2>&1 &
  chrome_launcher_pid=$!

  if ! chrome_pid="$(wait_for_user_process "--remote-debugging-port=${CHROME_DEBUGGING_PORT}" 100)"; then
    echo "Timed out waiting for Chrome to start" >&2
    cat /tmp/google-chrome.log >&2 || true
    exit 1
  fi
}

start_desktop_runtime() {
  local xfce_command
  local terminal_command

  Xvfb "${DISPLAY}" -screen 0 1440x900x24 -ac &
  xvfb_pid=$!

  wait_for_file /tmp/.X11-unix/X0

  xfce_command="$(cat <<EOF
export DISPLAY=${DISPLAY}
export HOME=${DESKTOP_HOME}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
export XAUTHORITY=${DESKTOP_XAUTHORITY}
export ICEAUTHORITY=${DESKTOP_ICEAUTHORITY}
export XDG_SESSION_TYPE=x11
export DESKTOP_SESSION=xfce
export XDG_CURRENT_DESKTOP=XFCE
exec dbus-launch --exit-with-session startxfce4
EOF
)"
  terminal_command="$(cat <<EOF
export DISPLAY=${DISPLAY}
export HOME=${DESKTOP_HOME}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
export XAUTHORITY=${DESKTOP_XAUTHORITY}
export ICEAUTHORITY=${DESKTOP_ICEAUTHORITY}
xfce4-terminal --disable-server
EOF
)"

  su -s /bin/bash -c "${xfce_command}" "${DESKTOP_USER}" >"${STARTXFCE_LOG_PATH}" 2>&1 &
  xfce_launcher_pid=$!

  if ! xfce_pid="$(wait_for_user_process "xfce4-session|xfwm4|startxfce4" 100)"; then
    echo "Timed out waiting for XFCE to start" >&2
    cat "${STARTXFCE_LOG_PATH}" >&2 || true
    exit 1
  fi

  sleep 3

  su -s /bin/bash -c "${terminal_command}" "${DESKTOP_USER}" >/tmp/xfce4-terminal.log 2>&1 &

  start_browser

  x11vnc \
    -display "${DISPLAY}" \
    -rfbport 5900 \
    -localhost \
    -forever \
    -shared \
    -nopw \
    -quiet &
  x11vnc_pid=$!

  sleep 1

  websockify --web /usr/share/novnc 6080 localhost:5900 &
  websockify_pid=$!

  echo "Desktop runtime started"
}

trap cleanup EXIT

echo "Waiting for sandbox API..."
until nc -z 127.0.0.1 8080; do
  sleep 0.1
done
echo "Sandbox API ready"

start_desktop_runtime

pids=()
for pid in \
  "${sandbox_api_pid:-}" \
  "${xvfb_pid:-}" \
  "${xfce_launcher_pid:-}" \
  "${chrome_launcher_pid:-}" \
  "${x11vnc_pid:-}" \
  "${websockify_pid:-}"; do
  if [[ -n "${pid}" ]]; then
    pids+=("${pid}")
  fi
done

wait -n "${pids[@]}"
