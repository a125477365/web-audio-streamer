#!/bin/bash
#
# Web Audio Streamer 一键安装脚本
# 支持 macOS / Linux / Windows (Git Bash)
#

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "========================================="
echo "  Web Audio Streamer 安装脚本"
echo "========================================="
echo -e "${NC}"

# 检测操作系统
detect_os() {
  case "$(uname -s)" in
    Darwin*)    echo "macos" ;;
    Linux*)     echo "linux" ;;
    CYGWIN*|MINGW*|MSYS*)    echo "windows" ;;
    *)          echo "unknown" ;;
  esac
}

OS=$(detect_os)
echo -e "${GREEN}[√] 检测到操作系统: $OS${NC}"

# 检查 Node.js
check_node() {
  if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}[√] Node.js 已安装: $NODE_VERSION${NC}"
  else
    echo -e "${RED}[×] Node.js 未安装${NC}"
    echo -e "${YELLOW}请先安装 Node.js: https://nodejs.org/${NC}"
    exit 1
  fi
}

# 检查 npm
check_npm() {
  if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    echo -e "${GREEN}[√] npm 已安装: $NPM_VERSION${NC}"
  else
    echo -e "${RED}[×] npm 未安装${NC}"
    exit 1
  fi
}

# 检查 FFmpeg
check_ffmpeg() {
  if command -v ffmpeg &> /dev/null; then
    FFMPEG_VERSION=$(ffmpeg -version 2>&1 | head -n1)
    echo -e "${GREEN}[√] FFmpeg 已安装${NC}"
    echo "    $FFMPEG_VERSION"
  else
    echo -e "${YELLOW}[!] FFmpeg 未安装，正在尝试安装...${NC}"
    install_ffmpeg
  fi
}

# 安装 FFmpeg
install_ffmpeg() {
  case "$OS" in
    macos)
      if command -v brew &> /dev/null; then
        brew install ffmpeg
        echo -e "${GREEN}[√] FFmpeg 安装完成${NC}"
      else
        echo -e "${RED}[×] 请先安装 Homebrew: https://brew.sh/${NC}"
        exit 1
      fi
      ;;
    linux)
      if command -v apt-get &> /dev/null; then
        sudo apt-get update && sudo apt-get install -y ffmpeg
      elif command -v yum &> /dev/null; then
        sudo yum install -y ffmpeg
      elif command -v pacman &> /dev/null; then
        sudo pacman -S ffmpeg
      else
        echo -e "${RED}[×] 无法自动安装 FFmpeg，请手动安装${NC}"
        exit 1
      fi
      echo -e "${GREEN}[√] FFmpeg 安装完成${NC}"
      ;;
    windows)
      echo -e "${YELLOW}[!] Windows 用户请手动安装 FFmpeg: https://ffmpeg.org/download.html${NC}"
      echo -e "${YELLOW}   或使用: choco install ffmpeg (需要 Chocolatey)${NC}"
      exit 1
      ;;
  esac
}

# 安装项目
install_project() {
  PROJECT_DIR="${1:-$HOME/web-audio-streamer}"
  
  echo -e "${BLUE}[→] 安装目录: $PROJECT_DIR${NC}"
  
  # 检查目录是否存在
  if [ -d "$PROJECT_DIR" ]; then
    echo -e "${YELLOW}[!] 目录已存在，跳过克隆${NC}"
  else
    echo -e "${BLUE}[→] 克隆项目...${NC}"
    git clone https://github.com/a125477365/web-audio-streamer.git "$PROJECT_DIR"
  fi
  
  cd "$PROJECT_DIR"
  
  # 安装依赖
  echo -e "${BLUE}[→] 安装 Node.js 依赖...${NC}"
  npm install
  
  echo -e "${GREEN}[√] 项目安装完成！${NC}"
}

# 配置检查
check_config() {
  CONFIG_FILE="$PROJECT_DIR/config/config.json"
  
  if [ -f "$CONFIG_FILE" ]; then
    echo -e "${GREEN}[√] 配置文件已存在${NC}"
  else
    echo -e "${YELLOW}[!] 配置文件不存在，创建默认配置...${NC}"
    # 使用项目中的默认配置
  fi
  
  echo ""
  echo -e "${YELLOW}重要：请编辑 $CONFIG_FILE 配置以下内容：${NC}"
  echo "  1. esp32.host - ESP32 的 IP 地址"
  echo "  2. esp32.port - UDP 端口（默认 8000）"
  echo "  3. music.localPaths - 本地音乐文件夹路径"
  echo ""
}

# 启动服务
start_server() {
  echo -e "${BLUE}[→] 启动服务...${NC}"
  echo ""
  echo -e "${GREEN}=========================================${NC}"
  echo -e "${GREEN}  Web Audio Streamer 已启动${NC}"
  echo -e "${GREEN}=========================================${NC}"
  echo ""
  echo -e "  访问地址: ${BLUE}http://localhost:3000${NC}"
  echo ""
  echo -e "  按 ${YELLOW}Ctrl+C${NC} 停止服务"
  echo ""
  
  cd "$PROJECT_DIR"
  npm run dev
}

# 显示帮助
show_help() {
  echo ""
  echo "使用方法: $0 [选项]"
  echo ""
  echo "选项:"
  echo "  --dir <路径>     指定安装目录 (默认: ~/web-audio-streamer)"
  echo "  --no-start       安装后不启动服务"
  echo "  --help           显示此帮助信息"
  echo ""
  echo "示例:"
  echo "  $0                           # 默认安装并启动"
  echo "  $0 --dir /opt/audio-streamer # 指定安装目录"
  echo "  $0 --no-start                # 只安装不启动"
  echo ""
}

# 主程序
main() {
  INSTALL_DIR="$HOME/web-audio-streamer"
  START_SERVER=true
  
  # 解析参数
  while [[ $# -gt 0 ]]; do
    case $1 in
      --dir)
        INSTALL_DIR="$2"
        shift 2
        ;;
      --no-start)
        START_SERVER=false
        shift
        ;;
      --help)
        show_help
        exit 0
        ;;
      *)
        echo -e "${RED}未知参数: $1${NC}"
        show_help
        exit 1
        ;;
    esac
  done
  
  # 执行安装步骤
  check_node
  check_npm
  check_ffmpeg
  install_project "$INSTALL_DIR"
  check_config
  
  if [ "$START_SERVER" = true ]; then
    start_server
  else
    echo -e "${GREEN}[√] 安装完成！${NC}"
    echo ""
    echo "启动服务请运行:"
    echo "  cd $INSTALL_DIR && npm run dev"
  fi
}

main "$@"
