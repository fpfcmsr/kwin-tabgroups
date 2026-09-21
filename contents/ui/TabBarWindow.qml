// The tab strip window.
//
// It must be the root of its own QML file: a Window declared inside an Item would
// become a transient child of a parent window, and a script has no parent window.
// KWin creates an internal window for it, keeps it above all other windows and
// delivers mouse events to it without taking the keyboard focus away.

import QtQuick
import QtQuick.Window as QW

QW.Window {
    id: overlay

    property var ctl: null
    property var view: ({ visible: false, geometry: null, tabs: [], hint: "", prompt: null, dragOut: 48 })
    property int menuIndex: -1

    readonly property int menuHeight: 64

    signal shown()

    title: "tabgroups-overlay"
    flags: Qt.FramelessWindowHint | Qt.WindowDoesNotAcceptFocus
    color: "transparent"
    visible: false
    // The position is applied by the controller through the window's geometry:
    // KWin places internal windows itself. Only the size is driven from here.
    width: view.geometry ? view.geometry.width : 480
    height: (view.geometry ? view.geometry.height : 30) + (menuIndex >= 0 ? menuHeight : 0)

    onVisibleChanged: if (visible) {
        shown();
    }

    function applyView(next) {
        overlay.view = next;
        if (!next.visible) {
            overlay.menuIndex = -1;
        }
        overlay.visible = next.visible;
    }

    // Position inside the row of tabs where a tab dropped at `localX` belongs.
    function dropIndex(index, localX) {
        var item = tabRepeater.itemAt(index);
        if (!item) {
            return index;
        }
        var pointerX = item.x + localX;
        var best = index;
        var bestDistance = Number.MAX_VALUE;
        for (var i = 0; i < tabRepeater.count; ++i) {
            var other = tabRepeater.itemAt(i);
            var distance = Math.abs(pointerX - (other.x + other.width / 2));
            if (distance < bestDistance) {
                bestDistance = distance;
                best = i;
            }
        }
        return best;
    }

    Rectangle {
        id: strip

        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: overlay.view.geometry ? overlay.view.geometry.height : 30
        color: Qt.rgba(0.09, 0.10, 0.11, 0.94)
        border.width: 1
        border.color: Qt.rgba(1, 1, 1, 0.14)
        radius: 5
        clip: true

        // Dragging the empty part of the strip moves the whole group.
        MouseArea {
            id: stripDrag

            anchors.fill: parent
            acceptedButtons: Qt.LeftButton
            property real lastX: 0
            property real lastY: 0

            onPressed: function (mouse) {
                lastX = mouse.x + overlay.x;
                lastY = mouse.y + overlay.y;
            }
            onPositionChanged: function (mouse) {
                if (!pressed || !overlay.ctl) {
                    return;
                }
                var gx = mouse.x + overlay.x;
                var gy = mouse.y + overlay.y;
                var dx = Math.round(gx - lastX);
                var dy = Math.round(gy - lastY);
                if (dx === 0 && dy === 0) {
                    return;
                }
                lastX += dx;
                lastY += dy;
                overlay.ctl.moveGroupBy(dx, dy);
            }
        }

        Row {
            id: tabRow

            anchors.left: parent.left
            anchors.leftMargin: 4
            anchors.right: ungroupButton.left
            anchors.rightMargin: 4
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            spacing: 2

            Repeater {
                id: tabRepeater

                model: overlay.view.tabs

                delegate: Rectangle {
                    id: tabItem

                    required property var modelData
                    required property int index

                    height: Math.max(tabRow.height - 4, 18)
                    width: Math.min(240, Math.max(96, tabLabel.implicitWidth + 18))
                    anchors.verticalCenter: parent.verticalCenter
                    radius: 4
                    color: tabItem.modelData.active
                           ? Qt.rgba(0.24, 0.68, 0.91, 0.92)
                           : (tabMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.12) : "transparent")

                    Text {
                        id: tabLabel

                        anchors.left: parent.left
                        anchors.leftMargin: 8
                        anchors.right: parent.right
                        anchors.rightMargin: 8
                        anchors.verticalCenter: parent.verticalCenter
                        text: tabItem.modelData.title
                        color: "white"
                        elide: Text.ElideRight
                        font.pixelSize: 12
                    }

                    MouseArea {
                        id: tabMouse

                        anchors.fill: parent
                        hoverEnabled: true
                        acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
                        property real pressX: 0
                        property bool dragging: false

                        onPressed: function (mouse) {
                            pressX = mouse.x;
                            dragging = false;
                        }
                        onPositionChanged: function (mouse) {
                            if (pressed && Math.abs(mouse.x - pressX) > 8) {
                                dragging = true;
                            }
                        }
                        onReleased: function (mouse) {
                            if (!overlay.ctl) {
                                return;
                            }
                            if (tabMouse.dragging) {
                                var outside = mouse.x < -overlay.view.dragOut
                                            || mouse.x > tabItem.width + overlay.view.dragOut;
                                if (outside) {
                                    overlay.ctl.detachTab(tabItem.index);
                                } else {
                                    overlay.ctl.reorderTab(tabItem.index,
                                                            overlay.dropIndex(tabItem.index, mouse.x));
                                }
                            } else if (mouse.button === Qt.MiddleButton) {
                                overlay.ctl.detachTab(tabItem.index);
                            } else if (mouse.button === Qt.RightButton) {
                                overlay.menuIndex = overlay.menuIndex === tabItem.index ? -1 : tabItem.index;
                            } else {
                                overlay.menuIndex = -1;
                                overlay.ctl.switchTo(tabItem.index);
                            }
                            tabMouse.dragging = false;
                        }
                    }
                }
            }
        }

        Rectangle {
            id: ungroupButton

            anchors.right: parent.right
            anchors.rightMargin: 4
            anchors.verticalCenter: parent.verticalCenter
            width: 20
            height: 20
            radius: 4
            visible: overlay.view.tabs.length > 1
            color: ungroupMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.16) : "transparent"

            Text {
                anchors.centerIn: parent
                text: "×"
                color: "white"
                font.pixelSize: 14
            }

            MouseArea {
                id: ungroupMouse

                anchors.fill: parent
                hoverEnabled: true
                onClicked: if (overlay.ctl) {
                    overlay.ctl.ungroupAll();
                }
            }
        }

        // Drop hint and confirmation take over the strip while they are up.
        Rectangle {
            id: message

            anchors.fill: parent
            z: 10
            radius: 5
            color: Qt.rgba(0.07, 0.08, 0.09, 0.97)
            visible: overlay.view.hint !== "" || overlay.view.prompt !== null

            Row {
                anchors.centerIn: parent
                spacing: 10

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    color: "white"
                    font.pixelSize: 12
                    text: overlay.view.prompt ? overlay.view.prompt.text : overlay.view.hint
                }

                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 62
                    height: 20
                    radius: 4
                    color: Qt.rgba(0.24, 0.68, 0.91, 1.0)
                    visible: overlay.view.prompt !== null

                    Text {
                        anchors.centerIn: parent
                        color: "white"
                        font.pixelSize: 11
                        text: overlay.view.prompt ? overlay.view.prompt.accept : ""
                    }

                    MouseArea {
                        anchors.fill: parent
                        onClicked: if (overlay.ctl) {
                            overlay.ctl.acceptPrompt();
                        }
                    }
                }

                Rectangle {
                    anchors.verticalCenter: parent.verticalCenter
                    width: 62
                    height: 20
                    radius: 4
                    color: Qt.rgba(1, 1, 1, 0.16)
                    visible: overlay.view.prompt !== null

                    Text {
                        anchors.centerIn: parent
                        color: "white"
                        font.pixelSize: 11
                        text: overlay.view.prompt ? overlay.view.prompt.cancel : ""
                    }

                    MouseArea {
                        anchors.fill: parent
                        onClicked: if (overlay.ctl) {
                            overlay.ctl.cancelPrompt();
                        }
                    }
                }
            }
        }
    }

    // Context menu for a tab, drawn inside the strip window so that no popup
    // window is needed.
    Rectangle {
        id: menu

        anchors.top: strip.bottom
        anchors.left: strip.left
        anchors.leftMargin: 48
        width: 150
        height: overlay.menuHeight - 8
        radius: 5
        color: Qt.rgba(0.11, 0.12, 0.13, 0.97)
        border.width: 1
        border.color: Qt.rgba(1, 1, 1, 0.14)
        visible: overlay.menuIndex >= 0

        Column {
            anchors.fill: parent
            anchors.margins: 4
            spacing: 2

            Rectangle {
                width: parent.width
                height: 24
                radius: 3
                color: detachMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.14) : "transparent"

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    color: "white"
                    font.pixelSize: 12
                    text: "Detach this tab"
                }

                MouseArea {
                    id: detachMouse

                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: if (overlay.ctl) {
                        overlay.ctl.detachTab(overlay.menuIndex);
                        overlay.menuIndex = -1;
                    }
                }
            }

            Rectangle {
                width: parent.width
                height: 24
                radius: 3
                color: ungroupAllMouse.containsMouse ? Qt.rgba(1, 1, 1, 0.14) : "transparent"

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 8
                    anchors.verticalCenter: parent.verticalCenter
                    color: "white"
                    font.pixelSize: 12
                    text: "Ungroup all"
                }

                MouseArea {
                    id: ungroupAllMouse

                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: if (overlay.ctl) {
                        overlay.ctl.ungroupAll();
                        overlay.menuIndex = -1;
                    }
                }
            }
        }
    }
}
