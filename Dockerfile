FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server/server.py .

# Data volume for SQLite + certs
VOLUME /app/data

EXPOSE 9090
EXPOSE 9443
EXPOSE 53/udp

ENTRYPOINT ["python", "server.py"]
CMD ["--port", "9090", "--https", "--db", "/app/data/phantom_grid.db"]
