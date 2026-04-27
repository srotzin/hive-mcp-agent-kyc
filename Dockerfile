# Dockerfile for Glama / Smithery / generic MCP hosting
FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
