# Kintsugi

**Live site: [kintsugi-colby.github.io](https://kintsugi-colby.github.io/)**

🏆 **Runner-up (2nd prize)** at the tri-college hackathon of Bowdoin, Bates, and Colby Colleges, hosted by Bowdoin. The theme was *Art, Creativity, and Technology*.

Kintsugi is the Japanese practice of mending broken pottery with seams of gold, making the repair visible instead of hiding it. This web app lets you write through a hard stretch of your life: each difficulty becomes a crack in a rendered bowl, and each thing that carried you through it becomes the gold filling that crack.

## How it works

1. **What was hard?** As you type, a crack grows across the bowl. Adding it leaves the crack open, and several cracks can be open at once.
2. **Mend a crack.** Pick an open crack and write what helped. If nothing did, choose "Something good" and name any good moment, however small. Press **Mend with gold** to fill the crack with gold.

Hover over a crack or gold seam to read the words behind it. **Keep this bowl** saves it under a name, and **My bowls** opens your kept bowls again so you can replay each one's story.

## Privacy

Your words are never sent anywhere. While you make a bowl they live only in memory. When you keep a bowl, it is saved (words included) in your browser's `localStorage`, on that device only.

## Running locally

This is a static site with no build step or dependencies. Open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server
```

Then visit http://localhost:8000.

## Files

- `index.html`: page structure and the SVG bowl
- `style.css`: styling
- `app.js`: crack generation, mending, and saved bowls
