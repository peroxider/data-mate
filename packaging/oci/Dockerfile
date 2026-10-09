# ---------------------------------------------------------------------------
# M4 容器交付(§24 / O02):与宿主安装共用同一发行物介质与同一 install.sh 入口。
# 构建期不访问网络(ADR007):基础镜像须预先导入本地镜像库,
# 可用 --build-arg BASE_IMAGE=<本地镜像> 指定。
# ---------------------------------------------------------------------------
ARG BASE_IMAGE=node:22.19-bookworm-slim
FROM ${BASE_IMAGE}

COPY data-analyst-*.tar.gz /tmp/media/
RUN cd /tmp/media \
    && tar -xzf data-analyst-*.tar.gz -C /tmp/media \
    && /tmp/media/data-analyst-*/packaging/host/install.sh \
        --media /tmp/media/data-analyst-* --prefix /opt \
    && rm -rf /tmp/media

ENV PATH="/opt/bin:${PATH}"
WORKDIR /opt/current
ENTRYPOINT ["/opt/bin/data-analyst"]
CMD ["serve", "--config", "/opt/current/config/config.example.yaml"]
