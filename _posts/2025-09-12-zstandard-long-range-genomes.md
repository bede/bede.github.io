---
layout: post
title: Zstandard's long range mode works wonders for genome sequences*
---

First released with Zstandard 1.3.2 in 2017, the `--long` range match finder increases the compressor's search window to at least 128MiB, improving deduplication inside large files. This optional feature had substantial performance overheads at launch, but various optimisations have since brought its performance within shooting distance of Zstandard's fast defaults. As a fan of Zstandard's speed and efficiency, I hoped that `--long` might improve genome compression and bridge the chasm between fast general-purpose compressors with low compression ratios (CRs), and much slower specialist DNA sequence compressors capable of far higher CRs.

Grace Blackwell's 2.6Tbp [661k](https://pmc.ncbi.nlm.nih.gov/articles/PMC8577725/) [dataset](https://ftp.ebi.ac.uk/pub/databases/ENA2018-bacteria-661k/) is a classic choice for benchmarking methods in microbial genomics. Comprising many similar DNA sequences, its 661,405 bacterial genome assemblies in FASTA text format are very compressible. Karel Břinda's specialist [MiniPhy approach](https://www.nature.com/articles/s41592-025-02625-2) takes this dataset from 2.46TiB to just 27GiB (CR: 91) by clustering and compressing similar genomes together. By comparison, naive Zstandard with default parameters compresses an order of magnitude faster, but achieves a CR of just 3.

I was initially underwhelmed by `--long`'s modest reduction of  the 661k dataset from 777GiB (Zstandard default) to 641GiB (CR: 4). I speculated that this poor performance might be caused by the newline bytes  (`0x0A`) punctuating every 60 characters of sequence, breaking the hashes used for long range pattern matching. Indeed, removing within-record newlines using [`seqtk seq -l 0`](https://github.com/lh3/seqtk?tab=readme-ov-file#seqtk-examples) tripled `zstd --long`'s CR to 11, yielding a 232GiB file while increasing compression time by only ~20% over Zstandard defaults. Increasing the window size to the 2GiB maximum on 64bit systems using `--long=31` tripled CR again to 31, yielding an 80GiB file, increasing compression time by ~80% over Zstandard defaults. Using larger-than-default window sizes has the drawback of requiring that the same `--long=xx` argument be passed during decompression, so reduces compatibility somewhat. But otherwise, `zstd --long` seems like a fast and easy way to achieve compression ratios within an order of magnitude of state-of-the-art methods like MiniPhy. Just remember to first remove within-record newlines from your fasta files.



***\*If uninterrupted by within-record newlines***




| File                        | Line length  | Size (GiB) | Compression ratio |
| --------------------------- | ------------ | ---------- | ----------------- |
| `661k.fasta` (uncompressed) | 60 (default) | 2460       | -                 |
| Gzip (pigz)                 | 60 (default) | 751        | 3.3               |
| Zstandard                        | 60 (default) | 777        | 3.2               |
| Zstandard `--long`               | 60 (default) | 641        | 3.8               |
| Zstandard `--long`               | 0 (infinite) | 232        | 11                |
| Zstandard `--long=31`            | 0 (infinite) | 80         | 31                |

<blockquote class="bluesky-embed" data-bluesky-uri="at://did:plc:hin5jjyb5dgi5wtjudeb62xm/app.bsky.feed.post/3lyfizwhenk2q" data-bluesky-cid="bafyreiajvdpuggyggtzbwiuvjockrtamnsbqfblvrsipmcqzqmbi3p6ieq" data-bluesky-embed-color-mode="system"><p lang="en">Zstandard&#x27;s --long range mode works wonders for assemblies, but needs uninterrupted single line sequences.

*AllTheBacteria 661k, multiline fasta*
gzip (pigz): 751GB
zstandard --long: 641GB (30% original size)

*Single line fasta*
gzip (pigz): 700GB
zstandard --long: 232GB (10% original size)</p>&mdash; Bede Constantinides (<a href="https://bsky.app/profile/did:plc:hin5jjyb5dgi5wtjudeb62xm?ref_src=embed">@bedec.bsky.social</a>) <a href="https://bsky.app/profile/did:plc:hin5jjyb5dgi5wtjudeb62xm/post/3lyfizwhenk2q?ref_src=embed">Sep 9, 2025 at 11:27</a></blockquote><script async src="https://embed.bsky.app/static/embed.js" charset="utf-8"></script>
