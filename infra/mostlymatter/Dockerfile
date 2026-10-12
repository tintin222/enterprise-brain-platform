# Mostlymatter 11.7.12: Mattermost without the 250-user cap (Q14, D11, D22), for the Phase 6 load test and
# staging. The pinned Team Edition image with its server binary replaced by Framasoft's Mostlymatter build of
# the same version. The SHA-512 below was checked against Framasoft's minisign signature (key
# RWSoFpHRlDgrwN2JmiT+JoV2nQBDzvhOgk4GGdmpzGRuhSRD4/F81JX3) on 2026-10-12; see docs/spike-findings.md.
# Mostlymatter is licensed like Mattermost (AGPL source, MIT-licensed builds); its logo is not used here.
FROM alpine:3.22.6@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS download
ARG MOSTLYMATTER_VERSION=v11.7.12
ARG MOSTLYMATTER_SHA512=8c4de8539b119e6d81046d24bafde1e9565b3a708b1424fa50f20455e370166963cea5569b0265e40f99e5942915861150831e1fd41b88aef541676ca42e7074
RUN wget -q -O /mostlymatter "https://packages.framasoft.org/projects/mostlymatter/mostlymatter-amd64-${MOSTLYMATTER_VERSION}" \
 && echo "${MOSTLYMATTER_SHA512}  /mostlymatter" | sha512sum -c -

FROM mattermost/mattermost-team-edition:11.7.12@sha256:618956b80399873f5c404d5dfc21ef07c3bad1169d603108a7a14cb932af5de7
COPY --from=download --chown=2000:2000 --chmod=755 /mostlymatter /mattermost/bin/mattermost
