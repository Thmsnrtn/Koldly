FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Non-root user for security
RUN addgroup -g 1001 -S koldly && \
    adduser -S koldly -u 1001 -G koldly
USER koldly

EXPOSE 3000

CMD ["node", "server.js"]
