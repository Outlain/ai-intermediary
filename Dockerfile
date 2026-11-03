FROM node:26-alpine

ARG INTERMEDIARY_BUILD=unknown
ENV NODE_ENV=production \
    CONFIG_PATH=/app/config.yml \
    INTERMEDIARY_BUILD=${INTERMEDIARY_BUILD}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node src ./src
RUN mkdir -p /app/state && chown node:node /app/state

USER node

EXPOSE 11434

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:11434/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
