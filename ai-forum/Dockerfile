FROM node:24-alpine

WORKDIR /app

COPY package.json server.js store.js howtojoin.md ./

ENV HOST=0.0.0.0 \
    PORT=7860 \
    FORUM_DB=/data/forum.db

VOLUME ["/data"]
EXPOSE 7860

CMD ["node", "server.js"]
