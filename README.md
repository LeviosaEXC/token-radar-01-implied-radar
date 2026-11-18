# Implied Radar — token-radar-01

Radar valuasi kondisional untuk protokol pre-token: mengurutkan 178 protokol
tanpa token berdasarkan nilai tersirat (implied value) seandainya token
diterbitkan, dari satu snapshot DefiLlama yang tersegel (14 Nov 2026, 758
protokol, floor $50M).

Model: regresi Huber pada log10(market cap) terhadap tangga elastisitas TVL
yang disusutkan (λ=0 dari 5-fold CV), tanpa satu pun fitur non-TVL yang lolos
gerbang ganda out-of-sample; offset kategori Empirical-Bayes (λ=∞ — semua
nol); pita split-conformal terstratifikasi; interval peringkat; dan ekonomi
farm net (deposit $2.500, drop 6%, gas skenario asumsi). Tidak ada
probabilitas peluncuran yang diestimasi — peringkat ini kondisional, bukan
ramalan peluncuran.

Cara menjalankan secara lokal (butuh Node 24):

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Perintah itu menulis `out/board.json`, menyalin `dashboard/` dan
`screenshots/` ke `out/`, lalu menulis `out/dossier.json`. Buka
`out/dashboard/index.html` di peramban — tanpa jaringan. Lencana di
kepala halaman membuktikan board.json sama dengan model halaman
(digest 178/178 cocok, drift $0).

[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/)
[![Rank](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar/rank.svg)](https://make.fun/)
[![Reward](https://make.fun/badge/token-radar-01/LeviosaEXC/token-radar-01-implied-radar/reward.svg)](https://make.fun/)

Sensus lengkap 758 protokol tercatat di tab Census & Methodology: 40
watchlist, 138 below-floor, 20 above-floor di luar watchlist, 128 +
16 set-aside, 88 comp terfit, 328 ref lain, 0 hold. Validasi
out-of-sample jujur dilaporkan di tab Model & Validation — termasuk
kekalahan model final dari baseline log-log global pada LOO sebesar 1,8%.
