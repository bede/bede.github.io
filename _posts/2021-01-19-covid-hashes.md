---
layout: post
title: Hash-based identifiers for SARS-CoV-2 spike sequences


---

The independent emergence of SARS-CoV-2 N501Y variants has proven tricky for those attempting to name lineages. Assigning pronounceable names following a coherently organised structure whilst at the same time acknowledging clinically significant mutations is a thorny problem, stimulating some interesting discussion threads on Twitter. The issue has consequences for experts and the general public alike, and slows down discourse about emerging variants when it matters most.

<blockquote  class="twitter-tweet"><p lang="en" dir="ltr">There is a lot of  discussion at the moment about naming SARS-CoV-2 variants and coming up  with a standardised naming system. There was some discussion of this  last week at the WHO <a  href="https://twitter.com/edwardcholmes?ref_src=twsrc%5Etfw">@edwardcholmes</a>  <a  href="https://twitter.com/EvolveDotZoo?ref_src=twsrc%5Etfw">@EvolveDotZoo</a>  <a  href="https://twitter.com/mvankerkhove?ref_src=twsrc%5Etfw">@mvankerkhove</a>  <a  href="https://twitter.com/JeremyFarrar?ref_src=twsrc%5Etfw">@JeremyFarrar</a>  <a  href="https://twitter.com/firefoxx66?ref_src=twsrc%5Etfw">@firefoxx66</a></p>&mdash;  Andrew Rambaut 🦠🧬🌲🔮🤦‍♂️ (@arambaut) <a  href="https://twitter.com/arambaut/status/1350156866559619074?ref_src=twsrc%5Etfw">January  15, 2021</a></blockquote> <script async src="https://platform.twitter.com/widgets.js"  charset="utf-8"></script>



TL;DR: I made a [web service for generating identifiers for spike sequences](https://konstel.ew.r.appspot.com/)



## Proposal

I propose referring to SARS-CoV-2 spike variants using a truncated hash of their spike protein sequence. This can easily be extended to other genes, and is why I suggest using a qualifying `S:` prefix. An encoded hash of a common B.1.1.7 spike protein sequence is therefore `S:mfcqn6mh3bnp7vv6eirptvbqik5c65ip`. This is clearly unnecessarily long, which is why I suggest truncating the hash in almost all circumstances. Initially four characters (32<sup>4</sup>) should suffice e.g. `S:mfcqn`, and longer versions of the hash may be used if/when collisions become a problem. These names are not compelling, but are short, easy to remember and to pronounce. Naturally this scheme could be used for any sequence from any organism, at the scale of individual or many genes.

[https://konstel.ew.r.appspot.com](https://konstel.ew.r.appspot.com/)

The input string may comprise only unambiguous IUPAC amino acid letters (`ARNDCQEGHILKMFPSTWYV`). Input sequences are stripped of whitepace and asterisks and converted to upper case. The sequence is then SHA1 hashed and its digest encoded in base32. This is implemented in ~5 lines of Python and is easy to recreate on the command line. The konstel package and web service can also translate genomic sequences containing an in-frame SARS-CoV-2 spike sequence without gaps or Ns, making the scheme easy to adopt in practice.

A next step will be to generate and make available the konstel IDs for all known spike sequences, and allow retrieval of sequences for a given konstel ID.



## Why not words?

Another way to generate high entropy indentifiers is to combine several dictionary words into phrases. This seems like a good idea and was the first thing I tried. unfortunately good wordlists are hard to come by, and the nature of language means that individually innocuous words combine into phrases that—whilst not necessarily being rude—often feel like inappropriate names for variants of a deadly disease. For example, the first three word phrase I generated from the [EFF long wordlist](https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases) was `fiscally-reactive-cabdriver`. It is of course entirely possible that next week's spike variant will have a base32 SHA1 beginning with `f**k` and this is a limitation of this scheme. However after generating a few hundred of these, I've seen no rude words, and many unsettling combinations of so-called safe dictionary words.
