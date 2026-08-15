# 构建 agent-harness 的原生 OS 沙箱 helper（Linux only）。
#
# 可选依赖（自动探测，缺失则对应能力降级）：
#   libseccomp  -> 系统调用过滤（seccomp）
#   libcap      -> 按名保留 capabilities
# 两者都不装也能编译，只是 seccomp / 选择性保留能力会被跳过；命名空间、只读根、
# 资源限制、丢弃全部能力、禁提权依然生效。

CC      ?= cc
SRC     := sandbox-exec.c
BUILD   := build
BIN     := $(BUILD)/sandbox-exec

# pkg-config 缺失时静默降级（2>/dev/null 吞掉报错）。
SECCOMP_CFLAGS := $(shell pkg-config --exists libseccomp 2>/dev/null && echo -DHAVE_LIBSECCOMP)
SECCOMP_LIBS   := $(shell pkg-config --exists libseccomp 2>/dev/null && echo -lseccomp)
CAP_CFLAGS     := $(shell pkg-config --exists libcap 2>/dev/null && echo -DHAVE_LIBCAP)
CAP_LIBS       := $(shell pkg-config --exists libcap 2>/dev/null && echo -lcap)

CFLAGS += -std=c11 -Wall -Wextra -O2 -D_GNU_SOURCE $(SECCOMP_CFLAGS) $(CAP_CFLAGS)
LIBS   := $(SECCOMP_LIBS) $(CAP_LIBS)

.PHONY: all clean
all: $(BIN)

$(BIN): $(SRC)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS) -o $(BIN) $(SRC) $(LIBS)

clean:
	rm -rf $(BUILD)
