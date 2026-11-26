Very hacky tab groups for KDE Plasma 

[Screencast_20261126_104548.webm](https://github.com/user-attachments/assets/d4e17409-f8a3-49f3-a7f5-a54f3fcf04d8)


- Tested with plasma 6.7 and 6.8 currently


Works for me, but it comes with absolutely no warranty if it bricks your Plasma session.   
Not compatible with Kwin scripts that modify similar behavior. 


How to install:  
download the latest .kwinscript from the Releases page, then  
System Settings > Window Management > KWin Scripts > Install from File...  
(or: kpackagetool6 --type=KWin/Script -i tabgroups-&lt;version&gt;.kwinscript, use -u to update)  
after an update, log out and back in so KWin picks up the new version  

From source:  
clone the repo then run install.sh  
to update: git pull -> then run ./dev/reload.sh  

How to release:  
bump "Version" in metadata.json and commit, then  
git tag v&lt;version&gt; && git push origin v&lt;version&gt;  
GitHub builds the .kwinscript and publishes the release  
