FROM node:20-bullseye
RUN apt-get update && apt-get install -y openjdk-17-jdk && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
EXPOSE 3000
ENV PORT=3000
CMD ["node","server.js"]
