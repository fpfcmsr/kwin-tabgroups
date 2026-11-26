Very hacky tab groups for KDE Plasma 

[Screencast_20261126_104548.webm](https://github.com/user-attachments/assets/d4e17409-f8a3-49f3-a7f5-a54f3fcf04d8)


- Tested with plasma 6.7 and 6.8 currently


Works for me, but it comes with absolutely no warranty if it bricks your Plasma session.   
Not compatible with Kwin scripts that modify similar behavior. 


How to install:  
System Settings > Window Management > KWin Scripts > Get New...  
search for "Tab Groups", install it and make sure it is ticked  
updates show up in the same Get New... dialog, log out and back in after updating  

From source:  
clone the repo then run install.sh  
to update: git pull -> then run install.sh again and log out and back in

License:  
GPL-2.0-or-later (GNU General Public License version 2, or any later version), see LICENSE
