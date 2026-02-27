FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY mock ./mock
COPY graphics ./graphics
COPY LICENSE README.md ./

RUN mkdir -p data logs

EXPOSE 8080
CMD ["node", "src/server.js"]
