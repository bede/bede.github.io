---
layout: post
title: Precise removal of host DNA sequences


---

In search of a lightweight approach for accurately removing human reads from microbial genomes and metagenomes, I found that existing methods removed surprisingly many bacterial reads, even from genomes with negligible similarity to the human genome. This motivated me to develop [Hostile](https://github.com/bede/hostile) ([preprint](https://www.biorxiv.org/content/10.1101/2023.07.04.547735)), which removes host reads from DNA sequences with an order of magnitude fewer false positives than existing approaches.

Why care about host decontamination? Microbial genomes are often contaminated with host DNA sequences. If that host is human, it is important to remove this personally identifiable information unless relevant consent has been granted. Host decontamination is also analytically useful, and avoids wasting resources processing and storing redundant data. However, the ad hoc fashion in which host decontamination is often performed leaves room for [serious errors](https://www.biorxiv.org/content/10.1101/2023.07.28.550993v1.full) that are widespread in published literature. Sometimes host decontamination is neglected entirely: [Bush et al. (2020)](https://doi.org/10.1099/mgen.0.000393) found that 6% of microbial genome submissions are meaningfully contaminated with human reads. The accuracy of these approaches is another concern…

## Evaluating accuracy

Host decontamination demands a balance of sensitivity and specificity. How many human reads can be retained while preserving donor privacy? How many inadvertently removed microbial reads cause a false variant call? Neither of these questions have straightforward answers. I compared the true and false positive rates of two widely-used existing approaches alongside Hostile:

**NCBI Scrubber**, also known as the human read removal tool (HRRT), is a recently-developed subtractive approach that builds on the MinHash-based [SRA Taxonomy Analysis Tool](https://doi.org/10.1186/s13059-021-02490-0) for masking or removing human reads. It typically allocates just 1GB of RAM, although sometimes uses a lot more for host-heavy data. It is reasonably fast, despite using uncompressed intermediate files. It does not accept gzipped FASTQ files, so compression and decompression is an exercise for the user.

**Kraken2** is a *k*-mer lowest common ancestor taxonomic classifier often repurposed for host decontamination using ad hoc scripts or [KrakenTools](https://github.com/jenniferlu717/KrakenTools). Periodically updated [prebuilt indexes](https://benlangmead.github.io/aws-indexes/k2) are convenient, although the 67GB 'standard' index rules out most computer hardware. Thinned-down 8GB and 16GB databases are available in return for reduced accuracy. Loading the index can take a minute or two, after which it runs blazingly fast.

**Hostile** subtracts host reads by aligning to a reference genome using either Minimap2 or Bowtie2, with Samtools used for counting and filtering in streaming fashion. It requires <4GB of RAM for short reads and approximately 14GB for long reads. It is reasonably fast and does not create temporary files. A custom index is downloaded automatically upon first use. Masked indexes are also available.

{% include 2023-08-29/accuracy.html %}

**Left:** False positive rate (FPR) was evaluated using 985 complete FDA-ARGOS bacterial genomes simulated at 10x depth using dwgsim. Hostile 0.1.0 (default unmasked index) had the lowest median false positive rate, retaining the most bacterial reads, followed by Kraken2 (standard, version 2.1.3, index version 2023-06-05), Kraken2 (standard 8), and finally NCBI Scrubber (2.2.1). Among the top 10 worst affected taxa were important human pathogens *Clostridioides difficile*, *Neisseria gonorrhoeae* and *Haemophilus influenzae*. Hover / tap on markers to reveal associated metadata.

**Right:** True positive rate (TPR) was evaluated using 27 real Illumina samples from the 1000 Genomes Project. A consequence of using real data from lymphoblastoid cell lines is that many of these samples are heavily contaminated with Epstein-Barr Virus, which has not been adjusted for here. Kraken2 (standard) had the highest median TPR, removing the most human reads, followed by Hostile, NCBI Scrubber, and finally Kraken2 (standard 8).

## Conclusions

Human read removal is a compromise. If you wish to remove as many human reads as possible and don't mind losing a few microbial reads along the way, use Kraken2 with the 67GB standard index. If you prioritise precision or require a less resource-intensive approach, use [Hostile](https://github.com/bede/hostile). Note that prebuilt masked databases are available for Hostile which further improve precision, and custom masked databases can be easily created. Please read the [preprint](https://www.biorxiv.org/content/10.1101/2023.07.04.547735) and cite it if you find it useful. Thanks for reading!
