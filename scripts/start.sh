#!/bin/bash
#
# Web Audio Streamer 启动脚本
# 自动检测并安装依赖，然后启动服务
#

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "========================================="
echo " Web Audio Streamer 启动检查"
echo "========================================="
echo -e "${NC}"

# 检测操作系统
detect_os() {
    case "$(uname -s)" in
        Darwin*) echo "macos" ;;
        Linux*) echo "linux" ;;
        CYGWIN*|MINGW*|MSYS*) echo "windows" ;;
        *) echo "unknown" ;;
    esac
}

OS=$(detect_os)

# 检查并安装 Node.js 依赖
check_node_deps() {
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}[!] Node.js 依赖未安装，正在安装...${NC}"
        npm install
        echo -e "${GREEN}[√] Node.js 依赖安装完成${NC}"
    else
        # 检查 package.json 是否比 node_modules 新
        if [ "package.json" -nt "node_modules" ]; then
            echo -e "${YELLOW}[!] package.json 已更新，重新安装依赖...${NC}"
            npm install
        else
            echo -e "${GREEN}[√] Node.js 依赖已就绪${NC}"
        fi
    fi
}

# 检查并安装 FFmpeg
check_ffmpeg() {
    if command -v ffmpeg &> /dev/null; then
        FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -n1)
        echo -e "${GREEN}[√] FFmpeg 已安装${NC}"
        echo "  $FFMPEG_VERSION"
    else
        echo -e "${YELLOW}[!] FFmpeg 未安装，正在尝试自动安装...${NC}"
        install_ffmpeg
    fi
}

# 安装 FFmpeg
install_ffmpeg() {
    case "$OS" in
        macos)
            if command -v brew &> /dev/null; then
                echo -e "${BLUE}[→] 使用 Homebrew 安装 FFmpeg...${NC}"
                brew install ffmpeg
                echo -e "${GREEN}[√] FFmpeg 安装完成${NC}"
            else
                echo -e "${RED}[×] 请先安装 Homebrew: https://brew.sh/${NC}"
                echo -e "${YELLOW}    或手动安装 FFmpeg: brew install ffmpeg${NC}"
                exit 1
            fi
            ;;
        linux)
            if command -v apt-get &> /dev/null; then
                echo -e "${BLUE}[→] 使用 apt-get 安装 FFmpeg...${NC}"
                sudo apt-get update && sudo apt-get install -y ffmpeg
            elif command -v yum &> /dev/null; then
                echo -e "${BLUE}[→] 使用 yum 安装 FFmpeg...${NC}"
                sudo yum install -y ffmpeg
            elif command -v pacman &> /dev/null; then
                echo -e "${BLUE}[→] 使用 pacman 安装 FFmpeg...${NC}"
                sudo pacman -S --noconfirm ffmpeg
            else
                echo -e "${RED}[×] 无法自动安装 FFmpeg${NC}"
                echo -e "${YELLOW}    请手动安装: sudo apt install ffmpeg${NC}"
                exit 1
            fi
            echo -e "${GREEN}[√] FFmpeg 安装完成${NC}"
            ;;
        windows)
            echo -e "${YELLOW}[!] Windows 用户请手动安装 FFmpeg:${NC}"
            echo -e "${YELLOW}    https://ffmpeg.org/download.html${NC}"
            echo -e "${YELLOW}    或使用: choco install ffmpeg${NC}"
            exit 1
            ;;
    esac
}

# 检查并创建配置文件
check_config() {
    CONFIG_FILE="config/config.json"
    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${YELLOW}[!] 配置文件不存在，创建默认配置...${NC}"
        mkdir -p config
        cat > "$CONFIG_FILE" << 'EOF'
{
  "esp32": {
    "host": "192.168.6.89",
    "port": 8000
  },
  "audio": {
    "sampleRate": 192000,
    "bitsPerSample": 32
  },
  "music": {
    "path": "./music",
    "localPaths": []
  },
  "server": {
    "port": 3010
  },
  "radio": {
    "presets": [
      { "name": "BBC World Service", "url": "https://stream.live.vc.bbcmedia.co.uk/bbc_world_service" },
      { "name": "Jazz FM", "url": "https://edge-bauerall-01-gos2.sharp-stream.com/jazz.mp3" }
    ]
  }
}
EOF
        echo -e "${GREEN}[√] 默认配置已创建${NC}"
    else
        echo -e "${GREEN}[√] 配置文件已存在${NC}"
    fi
}

# 检查 Hermes CLI 可用性
check_hermes() {
    HERMES_PYTHON="${HERMES_VENV_PYTHON:-/opt/hermes/.venv/bin/python3}"
    HERMES_CLI="${HERMES_CLI_PATH:-/opt/hermes/cli.py}"
    
    if [ -x "$HERMES_PYTHON" ] && [ -f "$HERMES_CLI" ]; then
        echo -e "${GREEN}[√] Hermes CLI 可用${NC}"
        echo "  Python: $HERMES_PYTHON"
        echo "  CLI: $HERMES_CLI"
    else
        echo -e "${YELLOW}[!] Hermes CLI 不可用（音源自动获取需要 Hermes）${NC}"
        echo -e "${YELLOW}    如需自动获取音源，请确保 Hermes Agent 正在运行${NC}"
    fi
}

# 创建音乐目录
check_music_dir() {
    if [ ! -d "music" ]; then
        echo -e "${YELLOW}[!] 创建音乐目录...${NC}"
        mkdir -p music
        echo -e "${GREEN}[√] 音乐目录已创建${NC}"
    else
        echo -e "${GREEN}[√] 音乐目录已存在${NC}"
    fi
}

# 主流程
main() {
    echo -e "${BLUE}[→] 检测操作系统: $OS${NC}"
    echo ""
    
    check_node_deps
    check_ffmpeg
    check_config
    check_music_dir
    check_hermes
    
    echo ""
    echo -e "${GREEN}=========================================${NC}"
    echo -e "${GREEN} 所有依赖已就绪，启动服务...${NC}"
    echo -e "${GREEN}=========================================${NC}"
    echo ""
    
    # 启动服务
    exec npm run dev
}

# 帮助信息
show_help() {
    echo ""
    echo "使用方法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --check-only  只检查依赖，不启动服务"
    echo "  --help        显示此帮助信息"
    echo ""
}

# 解析参数
case "${1:-}" in
    --help|-h)
        show_help
        exit 0
        ;;
    --check-only)
        check_node_deps
        check_ffmpeg
        check_config
        check_music_dir
        check_hermes
        echo ""
        echo -e "${GREEN}[√] 依赖检查完成${NC}"
        exit 0
        ;;
esac

main
