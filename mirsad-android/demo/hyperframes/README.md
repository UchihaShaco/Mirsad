# Animated demo (HyperFrames)

`mirsad/index.html` (English captions) and `mirsad-ar/index.html` (Arabic captions) are HyperFrames compositions that
animate the app's real screens and flow: a scam SMS arrives and is held, the reasons appear, the scammer's call is
rejected before it rings, a wrongly held message is restored with Not a scam, and the report preview opens.

Render (Node 22+, ffmpeg, Chrome):

```sh
cd mirsad    && npx --yes hyperframes@0.9.92 render --output ../../mirsad-android-demo-animated.mp4 --fps 30 --quality high
cd mirsad-ar && npx --yes hyperframes@0.9.92 render --output ../../mirsad-android-demo-animated-ar.mp4 --fps 30 --quality high
```
