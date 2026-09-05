Output artifacts/live-demo/work/02-install.mov

Require npm

Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 31
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
Type "rm -rf /tmp/qa-shop-demo-video"
Enter
Type "mkdir -p /tmp/qa-shop-demo-video"
Enter
Type "cp -R /Users/sudipmondal/mando/auto-qa/demo-app/. /tmp/qa-shop-demo-video/"
Enter
Type "cd /tmp/qa-shop-demo-video"
Enter
Show

Type "pwd"
Enter
Sleep 800ms

Type "find . -maxdepth 1 -type f -print | sort"
Enter
Sleep 2s

Type "cat package.json"
Enter
Sleep 4s

Type "npm ls --depth=0"
Enter
Sleep 4s
