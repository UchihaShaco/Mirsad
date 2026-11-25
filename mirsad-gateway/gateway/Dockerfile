FROM python:3.12-slim

ARG TAILSCALE_VERSION=1.104.7
ARG MITMPROXY_VERSION=12.3.1
ARG TARGETARCH=amd64

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl iptables iproute2 bind9-dnsutils procps \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}.tgz" \
      | tar -xz -C /tmp \
 && install -m 0755 /tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscale /usr/local/bin/tailscale \
 && install -m 0755 /tmp/tailscale_${TAILSCALE_VERSION}_${TARGETARCH}/tailscaled /usr/local/bin/tailscaled \
 && rm -rf /tmp/tailscale_*

RUN pip install --no-cache-dir "mitmproxy==${MITMPROXY_VERSION}" httpx

WORKDIR /app
COPY addon.py phone_sim.py passthrough.txt sim_urls.txt entrypoint.sh ./
COPY pages ./pages
RUN chmod +x entrypoint.sh

ENV SCAMSHIELD_STATE=/var/lib/scamshield \
    PYTHONUNBUFFERED=1

EXPOSE 8081 51820/udp
ENTRYPOINT ["/app/entrypoint.sh"]
