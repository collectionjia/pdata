#!/bin/sh
# Polymarket Docker 端口诊断 — 在服务器项目目录执行: sh docker-diagnose.sh
set -e
PORT=9004
NAME=polymarket-markets

echo "========== 1. 容器状态 =========="
docker ps -a --filter "name=$NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "========== 2. 最近日志（应含 监听: http://0.0.0.0:$PORT）=========="
docker logs "$NAME" --tail 15 2>&1 || true

echo ""
echo "========== 3. 容器内 curl =========="
docker exec "$NAME" wget -qO- "http://127.0.0.1:$PORT/api/health" 2>&1 && echo "" || echo "容器内访问失败"

echo ""
echo "========== 4. 宿主机 curl =========="
curl -sS -m 5 "http://127.0.0.1:$PORT/api/health" && echo "" || echo "宿主机 127.0.0.1 访问失败"

echo ""
echo "========== 5. 端口监听 =========="
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep "$PORT" || echo "未看到 $PORT 监听"

echo ""
echo "========== 6. Docker 端口映射 =========="
docker port "$NAME" 2>/dev/null || echo "无端口映射（可能用了 host 网络）"

echo ""
echo "========== 7. 公网 IP（浏览器应用此 IP:$PORT 访问）=========="
(curl -sS -m 3 ifconfig.me 2>/dev/null || curl -sS -m 3 ip.sb 2>/dev/null || echo "无法获取") && echo ""

echo ""
echo "========== 结论 =========="
echo "· 容器内 OK、宿主机 FAIL → Docker 端口映射问题，试:"
echo "  docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build"
echo "· 宿主机 OK、外网 FAIL → 云安全组/防火墙未放行 TCP $PORT"
echo ""
echo "========== 8. 若 9004 reset，试容器内 3457 =========="
docker exec "$NAME" wget -qO- "http://127.0.0.1:3457/api/health" 2>&1 && echo " → 应用在 3457，需改 ports 为 9004:3457" || echo "3457 也不通"
