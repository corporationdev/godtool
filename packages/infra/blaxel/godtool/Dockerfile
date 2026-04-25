FROM oven/bun:1-debian

WORKDIR /workspace

COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    dbus-x11 \
    ffmpeg \
    fonts-liberation \
    fonts-noto-color-emoji \
    git \
    gnupg \
    jq \
    nano \
    netcat-openbsd \
    novnc \
    nodejs \
    npm \
    procps \
    python3 \
    scrot \
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
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    google-chrome-stable \
  && update-ca-certificates \
  && ln -sf /usr/bin/python3 /usr/bin/python \
  && curl -fsSL https://code-server.dev/install.sh | sh \
  && useradd --create-home --shell /bin/bash desktop \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
