FROM node:20-bookworm-slim

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN chmod +x \
  e2e/docker/run-e2e.sh \
  e2e/docker/fake-bin/claude \
  e2e/docker/fake-bin/codex \
  e2e/docker/fake-bin/gemini \
  e2e/docker/fake-bin/opencode

CMD ["./e2e/docker/run-e2e.sh"]
