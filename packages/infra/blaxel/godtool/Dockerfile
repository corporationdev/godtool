FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    dbus \
    dbus-x11 \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    git \
    gnupg \
    hicolor-icon-theme \
    jq \
    libasound2 \
    nano \
    netcat-openbsd \
    novnc \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    scrot \
    thunar \
    tree \
    unzip \
    vim \
    websockify \
    wget \
    x11vnc \
    xauth \
    xclip \
    xdg-utils \
    xdotool \
    xfce4 \
    xfce4-panel \
    xfce4-session \
    xfce4-settings \
    xfce4-terminal \
    xfconf \
    xfdesktop4 \
    xfwm4 \
    xvfb \
    xz-utils \
    zip \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    google-chrome-stable \
    nodejs \
  && curl -fsSL https://bun.sh/install | bash \
  && npm install -g agent-browser @openai/codex \
  && curl -fsSL https://code-server.dev/install.sh | sh \
  && python3 -m pip install --no-cache-dir --upgrade pip \
  && python3 -m pip install --no-cache-dir "mitmproxy>=11,<12" \
  && ln -sf /usr/bin/python3 /usr/bin/python \
  && mkdir -p /etc/xdg/xfce4/xfconf/xfce-perchannel-xml \
  && if [[ ! -f /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml ]]; then \
    printf '%s\n' \
      '<?xml version="1.0" encoding="UTF-8"?>' \
      '<channel name="xfce4-session" version="1.0">' \
      '  <property name="general" type="empty">' \
      '    <property name="FailsafeSessionName" type="string" value="Failsafe"/>' \
      '  </property>' \
      '  <property name="sessions" type="empty">' \
      '    <property name="Failsafe" type="array">' \
      '      <value type="string" value="xfsettingsd"/>' \
      '      <value type="string" value="xfwm4"/>' \
      '      <value type="string" value="xfce4-panel"/>' \
      '      <value type="string" value="Thunar"/>' \
      '      <value type="string" value="xfdesktop"/>' \
      '    </property>' \
      '  </property>' \
      '</channel>' \
      > /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml; \
  fi \
  && useradd --create-home --shell /bin/bash desktop \
  && chown -R desktop:desktop /home/desktop \
  && chmod +x /usr/local/bin/sandbox-api \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY desktop-runtime.sh /usr/local/bin/godtool-desktop-runtime
RUN chmod +x /entrypoint.sh /usr/local/bin/godtool-desktop-runtime

ENTRYPOINT ["/entrypoint.sh"]
