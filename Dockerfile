# 使用多階段構建優化映像大小
FROM node:18-alpine AS base
WORKDIR /app

# 安裝必要的系統依賴
RUN apk add --no-cache \
    dumb-init \
    curl \
    && rm -rf /var/cache/apk/*

# 複製package文件並安裝依賴
COPY package*.json ./
# 使用更寬容且穩定的安裝方式，避免 lock 不同步導致 npm ci 失敗
RUN npm install --omit=dev --no-audit --prefer-offline \
    && npm cache clean --force

# 複製應用程式碼
COPY . .

# 創建非root用戶
RUN addgroup -g 1001 -S nodejs && \
    adduser -S backend -u 1001

# 設置適當的權限
RUN chown -R backend:nodejs /app
USER backend

# 健康檢查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

EXPOSE 3000

# 使用dumb-init作為PID 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
