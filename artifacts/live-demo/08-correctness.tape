Output artifacts/live-demo/work/08-correctness.mov

Require npm

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 30
Set Width 1920
Set Height 1080
Set Padding 42
Set Framerate 30
Set TypingSpeed 26ms
Set Theme "Catppuccin Mocha"
Set MarginFill "#0B1020"
Set Margin 28
Set BorderRadius 16
Set WindowBar "Colorful"
Set WindowBarSize 42

Hide
Type "cd /tmp/qa-shop-demo-video"
Enter
Show

Type "find .qa -maxdepth 3 -type f -print | sort"
Enter
Sleep 4s

Type "cat package.json"
Enter
Sleep 4s
