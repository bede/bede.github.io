---
layout: post
title: Hash-based identifiers for SARS-CoV-2 spike sequences


---

The emergence of increasingly convoluted 'constellations' of different SARS-CoV-2 variants is proving challenging for those attempting to organise the lineage naming. Assigning pronounceable names following a coherently organised structure whilst at the same time acknowledging clinically significant mutations is a thorny problem, stimulating interesting Twitter discussion in recent days. Delay and confusion over SARS-CoV-2 lineage naming has caused headaches for many including myself, slowing discourse about emerging variants when it matters most.

As explained by Trevor Bedford, the recently named `CAL.20C` lineage bearing `S:L452R`difficulties well, apparently straddling a number of existing lineages in the widely used and very useful Pango scheme. A single naming scheme cannot be everything to everyone, and I feel that there's a place for less opinionated hash-based schemes in the context of COVID and biological naming in general.

<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Take a look at the attached. You can see that the clade bearing S L452R includes samples with Pango lineages B.1, B.1.265, B.1.324, B.1.301, B.1.262, B.1.354. There&#39;s not a simple mapping to Pango lineage in this case. 2/3 <a href="https://t.co/Ej44WNZedJ">pic.twitter.com/Ej44WNZedJ</a></p>&mdash; Trevor Bedford (@trvrb) <a href="https://twitter.com/trvrb/status/1351671800300662785?ref_src=twsrc%5Etfw">January 19, 2021</a></blockquote> <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script> 



## Proposal

I propose referring to SARS-CoV-2 spike variants using a truncated hash of their spike protein sequence or a corresponding four syllable phoneme. This scheme can easily be extended to other genes, and is why I suggest using a qualifying `S:` prefix. An encoded hash of a common B.1.1.7 spike protein sequence is therefore `S:mfcqn6mh3bnp7vv6eirptvbqik5c65ip`. This is unnecessarily long, which is why I suggest truncating the hash in almost all circumstances. Initially four characters (32<sup>4</sup> possibilities) should suffice e.g. `S:mfcq`, and longer versions of the hash may be used if/when collisions become a problem. Each hash also corresponds to an easily pronounceable phoneme. These names are not exciting, but are short, easy to remember and to pronounce, and have a clearly defined meaning. In line with WHO advice, they also do not refer to geography. I feel that this approach could usefully complement existing manually curated naming schemes by providing (near) certainty of the exact sequence to which an identifier refers.

Web service: [https://konstel.ew.r.appspot.com](https://konstel.ew.r.appspot.com/)

The input string may comprise only unambiguous IUPAC amino acid letters (`ARNDCQEGHILKMFPSTWYV`). Input sequences are stripped of whitepace and asterisks and converted to upper case. The sequence is then SHA1 hashed and its digest encoded in base32. This is implemented in 4 lines of Python and available as a [command line tool and Python library](https://github.com/bede/konstel) in addition to the web service. Both implementations can also translate genomic sequences containing an in-frame & unambiguous SARS-CoV-2 spike sequence, making the scheme easy to adopt in practice. Naturally this or a similar scheme could be used for any sequence from any organism, at the scale of individual or many genes. 

A next step will be to generate and make available the identifiers for all known spike sequences, and allow retrieval of spike sequences by ID.



## Why not words?

Another way to generate high entropy indentifiers is to combine several dictionary words into phrases. This seems like a good idea and was the first thing I tried. unfortunately good wordlists are hard to come by, and the nature of language means that individually innocuous words combine into phrases that—whilst not necessarily being rude—often feel like inappropriate names for variants of a deadly disease. For example, the first three word phrase I generated from the [EFF long wordlist](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases) was `fiscally-reactive-cabdriver`. It is of course entirely possible that next week's spike variant will have a base32 SHA1 beginning with `f**k,` and this is a limitation of this scheme. However after generating a few hundred of these, I've seen no rude words, and many unsettling combinations of so-called safe dictionary words.