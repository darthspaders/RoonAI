FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# The Roon SDK uses config.json in the working directory. Keep pairing in the
# same persistent volume as Rabbit Hole's private databases and preferences.
RUN mkdir -p /app/data \
    && ln -s data/config.json /app/config.json \
    && chown -R node:node /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3777 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    LOCAL_LIBRARY_FFPROBE_PATH=/usr/bin/ffprobe \
    PC_MONITOR_ENABLED=false

USER node
EXPOSE 3777
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3777)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
