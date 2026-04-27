#!/usr/bin/env bash

set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
export DESKTOP_USER="${DESKTOP_USER:-desktop}"
export DESKTOP_HOME="${DESKTOP_HOME:-/home/desktop}"
export DESKTOP_PORT="${DESKTOP_PORT:-6080}"
export VNC_PORT="${VNC_PORT:-5900}"
export CHROME_DEBUGGING_PORT="${CHROME_DEBUGGING_PORT:-9222}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-desktop}"
export XDG_CONFIG_DIRS="${XDG_CONFIG_DIRS:-/etc/xdg:/etc}"
export XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export XDG_SESSION_TYPE=x11
export XDG_CURRENT_DESKTOP=XFCE
export DESKTOP_SESSION=xfce
export XAUTHORITY="${XAUTHORITY:-/tmp/desktop.Xauthority}"
export ICEAUTHORITY="${ICEAUTHORITY:-/tmp/desktop.ICEauthority}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-profile}"

STARTXFCE_LOG_PATH="${STARTXFCE_LOG_PATH:-/tmp/startxfce4.log}"
CHROME_LOG_PATH="${CHROME_LOG_PATH:-/tmp/google-chrome.log}"
TERMINAL_LOG_PATH="${TERMINAL_LOG_PATH:-/tmp/xfce4-terminal.log}"

cleanup() {
  for pid in \
    "${chrome_launcher_pid:-}" \
    "${terminal_launcher_pid:-}" \
    "${websockify_pid:-}" \
    "${x11vnc_pid:-}" \
    "${xfce_launcher_pid:-}" \
    "${xvfb_pid:-}" \
    "${dbus_system_pid:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" || true
    fi
  done
}

trap cleanup EXIT INT TERM

resolve_browser_binary() {
  local candidate

  for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  echo "Could not find a Chromium-based browser binary." >&2
  exit 1
}

wait_for_tcp() {
  local host="$1"
  local port="$2"
  local attempts="${3:-200}"
  local attempt=0

  until nc -z "${host}" "${port}" >/dev/null 2>&1; do
    attempt=$((attempt + 1))

    if (( attempt > attempts )); then
      echo "Timed out waiting for ${host}:${port}" >&2
      exit 1
    fi

    sleep 0.1
  done
}

wait_for_file() {
  local file_path="$1"
  local attempts="${2:-200}"
  local attempt=0

  until [[ -e "${file_path}" ]]; do
    attempt=$((attempt + 1))

    if (( attempt > attempts )); then
      echo "Timed out waiting for ${file_path}" >&2
      exit 1
    fi

    sleep 0.1
  done
}

wait_for_user_process() {
  local pattern="$1"
  local attempts="${2:-200}"
  local attempt=0
  local pid=""

  until [[ -n "${pid}" ]]; do
    pid="$(pgrep -u "${DESKTOP_USER}" -n -f -- "${pattern}" || true)"

    if [[ -n "${pid}" ]]; then
      printf '%s\n' "${pid}"
      return 0
    fi

    attempt=$((attempt + 1))

    if (( attempt > attempts )); then
      return 1
    fi

    sleep 0.1
  done
}

run_as_desktop_user() {
  local command="$1"

  su -s /bin/bash -c "${command}" "${DESKTOP_USER}"
}

prepare_desktop_environment() {
  mkdir -p \
    "${XDG_RUNTIME_DIR}" \
    "${CHROME_USER_DATA_DIR}" \
    "${DESKTOP_HOME}/Desktop" \
    "${DESKTOP_HOME}/.cache" \
    "${DESKTOP_HOME}/.config" \
    "${DESKTOP_HOME}/.gnupg" \
    "${DESKTOP_HOME}/.local/share/applications" \
    "${DESKTOP_HOME}/.local/share/pki/nssdb" \
    /run/dbus

  touch "${XAUTHORITY}" "${ICEAUTHORITY}"
  chown -R "${DESKTOP_USER}:${DESKTOP_USER}" \
    "${XDG_RUNTIME_DIR}" \
    "${CHROME_USER_DATA_DIR}" \
    "${DESKTOP_HOME}" \
    "${XAUTHORITY}" \
    "${ICEAUTHORITY}"
  chmod 700 "${XDG_RUNTIME_DIR}"
  chmod 700 "${DESKTOP_HOME}/.gnupg"

  if [[ ! -s /etc/machine-id ]]; then
    dbus-uuidgen > /etc/machine-id
  fi
  cp /etc/machine-id /var/lib/dbus/machine-id

  if [[ ! -S /run/dbus/system_bus_socket ]]; then
    dbus-daemon --system --fork --print-pid >/tmp/dbus-system.pid
    dbus_system_pid="$(cat /tmp/dbus-system.pid)"
  fi
}

start_xvfb() {
  rm -f /tmp/.X0-lock
  Xvfb "${DISPLAY}" -screen 0 1440x900x24 -ac -nolisten tcp &
  xvfb_pid=$!
  wait_for_file /tmp/.X11-unix/X0
}

start_xfce() {
  local xfce_command

  xfce_command="$(cat <<EOF
export DISPLAY=${DISPLAY}
export HOME=${DESKTOP_HOME}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
export XDG_CONFIG_DIRS=${XDG_CONFIG_DIRS}
export XDG_DATA_DIRS=${XDG_DATA_DIRS}
export XDG_SESSION_TYPE=${XDG_SESSION_TYPE}
export XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP}
export DESKTOP_SESSION=${DESKTOP_SESSION}
export XAUTHORITY=${XAUTHORITY}
export ICEAUTHORITY=${ICEAUTHORITY}
unset DBUS_SESSION_BUS_ADDRESS
unset SESSION_MANAGER
exec dbus-run-session -- startxfce4
EOF
)"

  run_as_desktop_user "${xfce_command}" >"${STARTXFCE_LOG_PATH}" 2>&1 &
  xfce_launcher_pid=$!

  if ! wait_for_user_process "xfce4-session|xfwm4|xfce4-panel|xfdesktop" 300 >/dev/null; then
    echo "Timed out waiting for XFCE to start" >&2
    cat "${STARTXFCE_LOG_PATH}" >&2 || true
    exit 1
  fi
}

start_terminal() {
  local terminal_command

  terminal_command="$(cat <<EOF
export DISPLAY=${DISPLAY}
export HOME=${DESKTOP_HOME}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
export XDG_CONFIG_DIRS=${XDG_CONFIG_DIRS}
export XDG_DATA_DIRS=${XDG_DATA_DIRS}
export XAUTHORITY=${XAUTHORITY}
export ICEAUTHORITY=${ICEAUTHORITY}
xfce4-terminal --disable-server
EOF
)"

  run_as_desktop_user "${terminal_command}" >"${TERMINAL_LOG_PATH}" 2>&1 &
  terminal_launcher_pid=$!
}

start_browser() {
  local browser_binary
  local browser_command

  browser_binary="$(resolve_browser_binary)"
  browser_command="$(cat <<EOF
export DISPLAY=${DISPLAY}
export HOME=${DESKTOP_HOME}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}
export XDG_CONFIG_DIRS=${XDG_CONFIG_DIRS}
export XDG_DATA_DIRS=${XDG_DATA_DIRS}
export XAUTHORITY=${XAUTHORITY}
export ICEAUTHORITY=${ICEAUTHORITY}
exec "${browser_binary}" \
  --user-data-dir="${CHROME_USER_DATA_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="${CHROME_DEBUGGING_PORT}" \
  --window-size=1440,900 \
  about:blank
EOF
)"

  run_as_desktop_user "${browser_command}" >"${CHROME_LOG_PATH}" 2>&1 &
  chrome_launcher_pid=$!

  if ! wait_for_user_process "--remote-debugging-port=${CHROME_DEBUGGING_PORT}" 200 >/dev/null; then
    echo "Timed out waiting for Chrome to start" >&2
    cat "${CHROME_LOG_PATH}" >&2 || true
    exit 1
  fi
}

start_vnc() {
  x11vnc \
    -display "${DISPLAY}" \
    -rfbport "${VNC_PORT}" \
    -localhost \
    -forever \
    -shared \
    -nopw \
    -quiet &
  x11vnc_pid=$!
  wait_for_tcp 127.0.0.1 "${VNC_PORT}"

  websockify --web /usr/share/novnc "${DESKTOP_PORT}" "127.0.0.1:${VNC_PORT}" &
  websockify_pid=$!
  wait_for_tcp 127.0.0.1 "${DESKTOP_PORT}"
}

prepare_desktop_environment
start_xvfb
start_xfce
sleep 1
start_terminal
start_browser
start_vnc

echo "Desktop runtime started on noVNC port ${DESKTOP_PORT}, VNC port ${VNC_PORT}"

wait -n "${xvfb_pid}" "${xfce_launcher_pid}" "${x11vnc_pid}" "${websockify_pid}"
