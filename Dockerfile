FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY config ./config
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 3456
CMD ["npm", "start"]
