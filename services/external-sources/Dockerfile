FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
RUN python -m playwright install --with-deps chromium
COPY app ./app
ARG APP_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/AntonyLang/roam-planner" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version=${APP_VERSION}
EXPOSE 8004
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8004"]
