---
layout: post
title: Memorable hash-based identifiers for SARS-CoV-2 sequences


---

The emergence of increasingly convoluted 'constellations' of different SARS-CoV-2 variants is proving challenging for those attempting to organise lineage naming. Assigning pronounceable names following a coherently organised structure whilst at the same time acknowledging clinically significant mutations is a thorny problem, stimulating interesting Twitter discussion in recent days. Delay and confusion over SARS-CoV-2 lineage naming has caused headaches for many including myself, slowing discourse about emerging variants when it matters most.

For example, the recently (and questionably) named `CAL.20C` lineage bearing `S:L452R` highlights these difficulties , apparently straddling a number of existing lineages in the widely used and very useful Pango scheme. This issue will likely be addressed in a matter of days, but is one of several difficulties in manually naming lineages, and I feel that there's a place for less opinionated hash-based schemes in the context of COVID and biological naming in general.

<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Take a look at the attached. You can see that the clade bearing S L452R includes samples with Pango lineages B.1, B.1.265, B.1.324, B.1.301, B.1.262, B.1.354. There&#39;s not a simple mapping to Pango lineage in this case. 2/3 <a href="https://t.co/Ej44WNZedJ">pic.twitter.com/Ej44WNZedJ</a></p>&mdash; Trevor Bedford (@trvrb) <a href="https://twitter.com/trvrb/status/1351671800300662785?ref_src=twsrc%5Etfw">January 19, 2021</a></blockquote> <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script> 



## Proposal

I propose referring to SARS-CoV-2 spike variants using a truncated hash of their spike protein sequence or a corresponding four syllable 'phoneme'. This scheme can easily be extended to other genes, and is why I suggest using a qualifying `S:` prefix. A base32 encoded SHA1 hash of a common B.1.1.7 spike protein sequence is `S:mfcqn6mh3bnp7vv6eirptvbqik5c65ip`. This is too long, which is why I suggest truncating the hash in almost all circumstances to `S:mfcq` or the corresponding phoneme `S:papoheme`. Initially 4 characters of a base32 hash (32<sup>4</sup> possibilities) or an 8 letter phoneme ((10*5)<sup>4</sup> possibilities) is adequate, and can be gracefully extended in length if collisions become a problem. These names are not exciting, but are short, easy to remember and to pronounce, and have a clearly defined meaning closely tied to biological function. In line with WHO advice, they also do not refer to geography. As these identifiers are randomly generated, it is quite possible that unsavoury identifiers will be generated, and so the choice of either a short hash or a phoneme derived from the same hash is a useful feature. I feel that this approach could nicely complement existing manually curated naming schemes by providing certainty about the actual biological sequence to which an identifier refers. 

Web service: [https://konstel.ew.r.appspot.com](https://konstel.ew.r.appspot.com/)

<a href="https://konstel.ew.r.appspot.com"><img src="/assets/2021-01-19/konstel-server.png" alt="Konstel web service" /></a>

The input string may comprise only unambiguous IUPAC amino acid letters (`ARNDCQEGHILKMFPSTWYV`). Input sequences are stripped of whitepace and asterisks and converted to upper case. The sequence is then SHA1 hashed and its digest encoded in base32. The phoneme is derived from the first 8 characters of the same hash encoded in base10, directly mapping 10 consonants and 5 vowels into decimal numbers. These are available as a [command line tool and Python library](https://github.com/bede/konstel) in addition to the web service. Both implementations can also translate genomic sequences containing an in-frame & unambiguous SARS-CoV-2 spike sequence, making the scheme easy to adopt in practice for SARS-CoV-2. Naturally this or a similar scheme could be used for any sequence from any organism, at the scale of individual or many genes. 

A next step will be to generate and make available the identifiers for all known spike sequences, and allow retrieval of spike sequences by ID.

---

*2021-01-20: Added phoneme description*

