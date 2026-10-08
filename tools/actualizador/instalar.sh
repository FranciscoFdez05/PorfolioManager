#!/usr/bin/env sh
# Instala el vigilante de actualizaciones como temporizador de systemd.
#
# Rellena solo el usuario y la ruta del proyecto (las tres líneas que había que
# editar a mano en el .service), copia el servicio y el temporizador y lo activa.
#
# Uso, en el servidor y desde cualquier sitio:
#   sudo ./tools/actualizador/instalar.sh [usuario]
#
# `usuario` es quien ejecuta docker-update.sh (por defecto, quien invocó sudo);
# tiene que poder usar `docker` sin contraseña.
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo "Ejecútalo con sudo: copia ficheros a /etc/systemd/system." >&2
    exit 1
fi
command -v systemctl >/dev/null 2>&1 || {
    echo "No hay systemd. Usa cron o un bucle: ver README.md." >&2
    exit 1
}

AQUI="$(cd "$(dirname "$0")" && pwd)"
PROYECTO="$(cd "$AQUI/../.." && pwd)"
USUARIO="${1:-${SUDO_USER:-}}"

if [ -z "$USUARIO" ] || [ "$USUARIO" = "root" ]; then
    echo "Indica el usuario que ejecuta docker: sudo $0 <usuario>" >&2
    exit 1
fi
id "$USUARIO" >/dev/null 2>&1 || { echo "No existe el usuario $USUARIO." >&2; exit 1; }
[ -f "$PROYECTO/docker-update.sh" ] || { echo "No encuentro docker-update.sh en $PROYECTO." >&2; exit 1; }

chmod +x "$AQUI/portfolio-actualizador.sh" "$PROYECTO/docker-update.sh"

DESTINO=/etc/systemd/system
sed -e "s|^User=.*|User=$USUARIO|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PROYECTO|" \
    -e "s|^ExecStart=.*|ExecStart=$AQUI/portfolio-actualizador.sh|" \
    -e "s|^Documentation=.*|Documentation=file://$AQUI/README.md|" \
    "$AQUI/portfolio-actualizador.service" > "$DESTINO/portfolio-actualizador.service"
cp "$AQUI/portfolio-actualizador.timer" "$DESTINO/portfolio-actualizador.timer"

systemctl daemon-reload
systemctl enable --now portfolio-actualizador.timer

echo "Instalado para $USUARIO en $PROYECTO."
systemctl list-timers portfolio-actualizador.timer --no-pager
echo "Hay una pasada cada 30 s; el aviso de Ajustes desaparece cuando la primera escribe data/tmp/actualizacion.estado."
