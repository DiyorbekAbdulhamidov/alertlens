# On-prem deployment: one container, numpy only, no outbound network needed.
#   docker build -t alertlens .
#   docker run -p 8000:8000 alertlens      -> http://<server>:8000
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY core core
COPY synth synth
COPY server server
COPY artifacts artifacts
COPY assets assets
COPY index.html dev_server.py ./
EXPOSE 8000
CMD ["python", "dev_server.py", "8000"]
