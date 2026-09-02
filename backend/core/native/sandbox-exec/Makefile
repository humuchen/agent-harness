# OS 级沙箱原生助手构建（Linux only）。
# 产物落在 build/sandbox-exec，与 detect.ts 中 resolveHelperPath() 的默认解析路径一致。
#
# 依赖：
#   - 硬依赖：glibc + Linux 头文件（sched.h / sys/mount.h / linux/capability.h 等）。
#   - 可选：libseccomp（apt install libseccomp-dev / yum install libseccomp-devel）。
#     pkg-config 探测到则启用 seccomp 系统调用过滤；探测不到则自动降级（编译仍成功，
#     运行期 seccomp 段被跳过，其余命名空间/rlimit/能力裁剪照常生效）。
#   注：capabilities 用裸 syscall 实现，不依赖 libcap。

CC      ?= cc
CFLAGS  ?= -std=c11 -Wall -Wextra -O2 -D_GNU_SOURCE
LDFLAGS :=
TARGET  := build/sandbox-exec
SRC     := sandbox-exec.c

# 探测可选依赖 libseccomp
PKG_SECCOMP := $(shell pkg-config --exists libseccomp 2>/dev/null && echo yes || echo no)
ifeq ($(PKG_SECCOMP),yes)
  CFLAGS  += -DHAVE_LIBSECCOMP $(shell pkg-config --cflags libseccomp)
  LDFLAGS += $(shell pkg-config --libs libseccomp)
endif

.PHONY: all clean
all: $(TARGET)

$(TARGET): $(SRC)
	@mkdir -p build
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDFLAGS)

clean:
	rm -rf build
