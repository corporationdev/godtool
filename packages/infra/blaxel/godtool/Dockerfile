FROM oven/bun:1-debian

WORKDIR /workspace

COPY --from=ghcr.io/blaxel-ai/sandbox:latest /sandbox-api /usr/local/bin/sandbox-api

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    jq \
    nano \
    netcat-openbsd \
    nodejs \
    npm \
    procps \
    python3 \
    tree \
    unzip \
    vim \
    wget \
    zip \
  && update-ca-certificates \
  && ln -sf /usr/bin/python3 /usr/bin/python \
  && curl -fsSL https://code-server.dev/install.sh | sh \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
