FROM node:24-alpine AS deps

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY mock ./mock
COPY graphics ./graphics
COPY LICENSE README.md ./

RUN mkdir -p data logs \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

EXPOSE 8080
CMD ["node", "src/server.js"]
