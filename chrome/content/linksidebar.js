/*
Copyright 2008 - 2011, Varun Naik

This file is part of LinkSidebar.

LinkSidebar is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

LinkSidebar is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with LinkSidebar.  If not, see <http://www.gnu.org/licenses/>.
*/


var Linksidebar = {
	linkList : [],
	page: {url: null, title: null, currentTest: null},
	
	numLinksLoaded: null,
	searchToken: null,
	linksLocked: null,
	prefs: null,
	sortOrder: {order: null, field: null}, // order = 1 (natural), 0(asc) and 2(desc); Field = name/URL/Domain/Status
	
	testedLinks: [],
	runningThreads: null,	
	runningTests: [],

	overlayLinks: [],			// Links that have been highlighted in the current page
	mouseOverHighlight: false, // Whether the mouse is over a highlighted element or not
	outlinedTreeItems: [],		// Tree items that have outlined items
	hasTested: false,			// True if the currently loaded links has at least one tested link.

	urlBarListener : 
	{
		QueryInterface: function(aIID)
		{
			if (aIID.equals(Components.interfaces.nsIWebProgressListener) ||
				aIID.equals(Components.interfaces.nsISupportsWeakReference) ||
					aIID.equals(Components.interfaces.nsISupports))
						return this;
			throw Components.results.NS_NOINTERFACE;
		},
		onLocationChange: function(aProgress, aRequest, aURI)
		{
			var wm;
			var currentTab;
			if (Linksidebar.linksLocked)
				return 0;
				
			Linksidebar.removeLinkOverlay();	// Hide highlights on highlighted links

			// Page changed, refresh the list of links
			Linksidebar.getLinks();
			Linksidebar.showTree();
		
			// Determine if we should show the 'cancel test' button or not
			wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
					.getService(Components.interfaces.nsIWindowMediator);
			currentTab = wm.getEnumerator('navigator:browser').getNext().getBrowser().selectedTab;
			
			if (currentTab.hasAttribute("linksidebar-testing")) {
				Linksidebar.showCancelTestButton(true);
				Linksidebar.page.currentTest = currentTab.getAttribute("linksidebar-testing");
			}else
				Linksidebar.showCancelTestButton(false);

			return 0;
		},

		onProgressChange: function(aWebProgress, aRequest, aCurSelfProgress, aMaxSelfProgress, aCurTotalProgress, aMaxTotalProgress)
		{
			if (Linksidebar.linksLocked)
				return 0;

			Linksidebar.getLinks();
			if (aCurTotalProgress < aMaxTotalProgress)
				Linksidebar.showTree(true);
			else {
				Linksidebar.showTree();
			}
			
			return 0;
				   
		},
		
		onStatusChange: function() { return 0;},
		onStateChange: function() { },
		onSecurityChange: function() {},
		onLinkIconAvailable: function() {}
	},
	
	init: function()
	{
		var toolbarButton;
		var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIWebNavigation)
						.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
						.rootTreeItem
						.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIDOMWindow);
		
		mainWindow.getBrowser().addProgressListener(this.urlBarListener,
        Components.interfaces.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
		
		this.prefs = Components.classes["@mozilla.org/preferences-service;1"]
							.getService(Components.interfaces.nsIPrefService)
								.getBranch("linksidebar.");
		this.prefs.QueryInterface(Components.interfaces.nsIPrefBranch2);
		this.prefs.addObserver("", this, false);
		
		toolbarButton = mainWindow.document.getElementById('linksidebar-toolbarbutton');
		if (toolbarButton)
			toolbarButton.checked = true;
		
		// Set the max sidebar width
		//mainWindow.document.getElementById("sidebar").setAttribute('style', 'overflow-x: hidden;');
		//mainWindow.document.getElementById("sidebar-box").setAttribute('style', 'max-width: ' + (window.screen.width - 10) + 'px; overflow-x: hidden;');

		// Listen for tab close so we can cancel any tests running on that tab
		mainWindow.getBrowser().tabContainer.addEventListener("TabClose", this.tabRemoved, false);;
			
		/* Prototype function to get the index of a tested url, if it is present in the testedLinks array	*/
		Array.prototype.indexOfUrl = function(url)
		{
			var i;
			for (i = 0; i < this.length; i++)
			  if (this[i].href === url)
				return i;
			return -1;
		};
		
		/* Prototype to find index of a running test in the runningTests array, by name */
		Array.prototype.findByName = function(name)
		{
			var i;
			for (i = 0; i < this.length; i++)
			  if (this[i].name === name)
				return i;
			return -1;
		};
		
		this.sidebarInit();
	},
	
	unInit: function()
	{
		var toolbarButton;
		var i;
		var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIWebNavigation)
						.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
						.rootTreeItem
						.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIDOMWindow);
		mainWindow.getBrowser().removeProgressListener(this.urlBarListener);
		
		// Stop listening for tab closes
		mainWindow.getBrowser().tabContainer.removeEventListener("TabClose", this.tabRemoved, false);
		
		this.prefs.removeObserver("", this);
		
		
		// Reset the max sidebar width
		//mainWindow.document.getElementById("sidebar-box").removeAttribute('style');
		//mainWindow.document.getElementById("sidebar").removeAttribute('style');

		// tell the test thread to quit
		for (i = this.runningTests.length - 1; i >= 0;  i--) {// A test could be spliced out while this loop is running, thus changing the length - that's why we go in reverse
			this.runningTests[i].run = false;
			this.runningTests[i].update = false;
		}
		
		this.removeLinkOverlay(); // Remove highlighted links' highlights
		
		toolbarButton = mainWindow.document.getElementById('linksidebar-toolbarbutton');		
		if (toolbarButton)
			toolbarButton.checked = false;
	},
	
	/* Determines if the closed tab had any running link tests, and cancels them if it did *
	 * 3:09 PM 9/26/2008, Varun Naik								     */
	/* Also un-highlights links if needed */
	tabRemoved: function(event)
	{
		var index;
		var name;
		var tabBrowser = event.target;
		
		Linksidebar.removeLinkOverlay();	// Hide highlights on highlighted links
		
		if (Linksidebar.linksLocked) // Locked links in the sidebar persist even when the tab they belong to is closed - we should not abort the test in this case
			return;

		if ((name = tabBrowser.getAttribute("linksidebar-testing"))) {
			// remove the attribute
			index = Linksidebar.runningTests.findByName(name);
			Linksidebar.runningTests[index].run = false;
			Linksidebar.runningTests[index].update = false;
		
			// remove the attribute here - this would normally be done in the test thread, but the test thread can't get a reference to this tab, since it's been closed
			tabBrowser.removeAttribute("linksidebar-testing");
		}	  
	},
	
	observe: function(subject, topic, data)
	{
		if (topic != "nsPref:changed")
		{
			return;
		}
		switch(data)
		{		
			case "linkcol": case "bgcol": case "customBgCol": case "customLinkcol":
				if (!Linksidebar.linksLocked)	
					this.getLinks();
				this.showTree();			
			break;
			case "showStatus":
				if (this.prefs.getCharPref("showStatus") == "text")
					document.getElementById('linksidebar-linkStatus').setAttribute('style', 'max-width: 80px !important; width: 80px !important; min-width: 80px !important');
				else
					document.getElementById('linksidebar-linkStatus').setAttribute('style', 'max-width: 19px !important; width: 19px !important; min-width: 19px !important;');
				// Reload tree, but only if the status field is currently visible
				if(! document.getElementById('linksidebar-linkStatus').hasAttribute('hidden')) {
					if (!Linksidebar.linksLocked)	
						this.getLinks();
					this.showTree();
				}
			break;
			case "showDuplicates":
				if (!Linksidebar.linksLocked)	
						this.getLinks();
					this.showTree();			
			break;
		}
	},

	/* Retrieves all links from the current document and populates the tree */
	sidebarInit: function()
	{
		try {
			this.runningThreads = 0;
			this.searchTokens = "";
			this.linksLocked = false;
			this.getLinks();	
			this.showTree();
			var bundle = document.getElementById('linksidebar-stringBundle');

			// Get the app version. FF3.0 needs a 'timed' typ searchbox, while 3.5 needs a 'search' type.
			var appInfo = Components.classes["@mozilla.org/xre/app-info;1"]
			                        .getService(Components.interfaces.nsIXULAppInfo);
			var versionChecker = Components.classes["@mozilla.org/xpcom/version-comparator;1"]
			                               .getService(Components.interfaces.nsIVersionComparator);
			if(versionChecker.compare(appInfo.version, "3.5") >= 0) {
				var textbox = document.getElementById('search-links-in-list');
				textbox.setAttribute('type', 'search');
				textbox.removeAttribute('onfocus');
				textbox.removeAttribute('onblur');
				textbox.setAttribute('emptytext', bundle.getString('searchMsg'));
			} 
			this.textboxFocus();
			
			// hide the status col; it won't be needed till someone tests a link
			var statusCol = document.getElementById('linksidebar-linkStatus');
			if (statusCol.hidden == false)
				statusCol.hidden = true;
				
			// Set statuscol width depending on user preferences
			if (this.prefs.getCharPref("showStatus") == "text")
				document.getElementById('linksidebar-linkStatus').setAttribute('style', 'max-width: 80px !important; width: 80px !important;');
			else
				document.getElementById('linksidebar-linkStatus').setAttribute('style', 'max-width: 16px !important; width: 16px !important;');
				
		} catch (e) {
			throw ("linksidebar.sidebarInit()\n" + e);
		}
	},

	reloadTree: function()
	{
		try {
			this.getLinks();
			this.showTree();			
			this.textboxFocus();
		} catch (e) {
			throw ("linksidebar.reloadTree()\n" + e);
		}
	},
	
	sortLinks: function(links)
	{
		try {		
			// Order: Http 100, 200, 300,400,500, Error, Timeout, not supported, testing in progress
			function compareStatus(a, b) {
				// If a < b, return -1. If a > b return 1. if a = b return 0
				var i, j; // Test a index. test b index
				i = Linksidebar.testedLinks.indexOfUrl(Linksidebar.linkList[a].url);
				j = Linksidebar.testedLinks.indexOfUrl(Linksidebar.linkList[b].url);
				if (i == -1 &&  j  == -1)
					return 0;
				else if (i == -1)
					return -1; // Show tested first and then untested
				else if (j == -1)
					return 1;

				if (Linksidebar.testedLinks[i].statusColor < Linksidebar.testedLinks[j].statusColor)
					return 1; // Show green then red
				else if (Linksidebar.testedLinks[i].statusColor > Linksidebar.testedLinks[j].statusColor)
					return -1; // Show green then red
				
				// If we've reached this point the two statuses are equal
				if (Linksidebar.testedLinks[i].statusColor == 2) {
					if ((Linksidebar.testedLinks[i].testTime - Linksidebar.testedLinks[i].startTime) < (Linksidebar.testedLinks[j].testTime - Linksidebar.testedLinks[j].startTime))
						return -1;
					else if ((Linksidebar.testedLinks[j].testTime - Linksidebar.testedLinks[j].startTime) < (Linksidebar.testedLinks[i].testTime - Linksidebar.testedLinks[i].startTime))
						return 1;
				} else if (Linksidebar.testedLinks[i].statusColor == 4) {
					if (Linksidebar.testedLinks[i].status < Linksidebar.testedLinks[j].status)
						return -1;
					else if (Linksidebar.testedLinks[j].status < Linksidebar.testedLinks[i].status)
						return 1;
				}
				return 0;			
			}
			
			function compare (s1, s2) {
				s1 = s1.toLowerCase(); s2 = s2.toLowerCase();
				s1Words = s1.split(" ");
				s2Words = s2.split(" ");
				i = 0;
				while (s1Words[i] == s2Words[i]) {
					i++;
					if (i == s1Words.length || i == s2Words.length)
						break;
				}
				if (s1Words.length == i && s2Words.length > i)
					return -1;
				else if (s2Words.length == i && s1Words.length > i)
					return 1;
				else if (s2Words.length == s1Words.length && s1Words.length == i)
					return 0;	
				else if (s1Words[i] < s2Words[i])
					return -1;
				else if (s1Words[i] > s2Words[i])
					return 1;
			}
			
			function compareText(a, b) {
				return compare(Linksidebar.linkList[a].text, Linksidebar.linkList[b].text);
			}
			
			function compareUrl(a,b) {
				return compare(Linksidebar.linkList[a].url, Linksidebar.linkList[b].url);
			}
			
			function compareDomain(a,b) {
				return compare(Linksidebar.linkList[a].domain, Linksidebar.linkList[b].domain);
			}
			
			if (this.sortOrder.field == "linksidebar-linkUrl") {
				links.sort(compareUrl);		
			} else if (this.sortOrder.field  == "linksidebar-linkName") {
				links.sort(compareText);	
			} else if (this.sortOrder.field  == "linksidebar-linkDomain") {
				links.sort(compareDomain);	
			} else if (this.sortOrder.field  == "linksidebar-linkStatus") {
				links.sort(compareStatus);	
			} else throw ("error: unexpected sort type.\n");
			return links;
		} catch (e) {
			throw ("Linksidebar: Sort Links: error during execution\n" + e);
		}
	},

	/* This function adds each element of the links array to the hierachial tree, in order								 *
	   * If ithe incremental  parameter is set, the load is done incrementally. Only items matching the searchTokens  will be added to the tree  	* 
	   **Warning* using incremental in any scenario other than when a page is loading may cause errors     					 */
	showTree: function(incremental)
	{
		try {
			var i, j, k;		
			var item, row, cell;			// Treeitem, Treerow and Treecell
			var linksTree;					// The tree
			var linksTreeChildren;			// Tree children of the tree			
			var linkCell;					// Treecell showing the link name
			var urlCell;					// Treecell showing the URL 
			var domainCell;					// Treecell showing the domain of the target URL
			var statusCell;					// Treecell holding the tested status of the link			
			var result; 					// holds the result of the regular expression execution
			var numLinksLabel;				// Label showing the number of links we got on this page
			var match;						// Bool indicating if a searchterm was matched with the current link
			var styleSheet;					// The stylesheet for the extension
			var numRules;					// The number of rules in the stylesheet
			var color;						// The color to be used for this link
			var colorVals;					// Array containing r,g,b values for the link
			var propName;					// The color property for this treeitem
			var numLinksLoaded;				// No. of links loaded in this run of this function
			var colorRules;					// Array containing all color rules loaded into stylesheet
			var colorCorrection;			// Used to reduce brightness of links so they are easily visible against the tree background
			var customLinkColor;			// Should we use a custom link color
			var customLinkColorValue;		// Custom link color to be used, if specified
			var customBgColor;
			var customBgColorValue;
			var testIndex;					// Holds the index into the tested links array of a link that was tested
			var boxObject;					// The tree box object
			var bundle;						// string bundle to hold localised string message (xx hyperlinks in page)
			var treeLinks;					// Array to hold all links to be displayed
			var stopValue;
			var numTested;					// Number of tested links in the current tab
			var map;						// Mapping between treelinks[] and this.linklist[]
			//var filteredLinksList;			// Array of links to be filtered out. Set in the filter links dialog box.
			//var filterLinks;				// Should we apply the filter or not?	
			
			this.removeLinkOverlay() // Remove highlights if any
		
			if (typeof (this.searchTokens) == 'undefined') {
				throw ("Linksidebar: showTree: error: did not get text to search");
			}
			
			bundle = document.getElementById('linksidebar-stringBundle');

			numRules = 0;
			colorRules = [];
			
			// Get preferences, if any
			customLinkColor = this.prefs.getBoolPref("customLinkcol");
			customBgColor = this.prefs.getBoolPref("customBgCol");
			
			// The only way to style individual treecells is to use an external stylesheet.
			for (i = 0; i < document.styleSheets.length; i++)
				// get the stylesheet
				if (document.styleSheets[i].href.match("linksidebarLinks.css")) {
					styleSheet = document.styleSheets[i];					
					
					numRules = 0;
					break;
				}
				
			linksTree = document.getElementById('list-of-links');
			
			// Create the tree children element for the link list tree, if it does not exist already 
			for (i = 0; i < linksTree.childNodes.length; i++) {
				if (linksTree.childNodes[i].tagName.toLowerCase() == "treechildren") {
					linksTreeChildren = linksTree.childNodes[i];
					break;
				}				
			}

			if (i == linksTree.childNodes.length) {			
				linksTree.appendChild(document.createElement("treechildren"));
				linksTreeChildren = linksTree.childNodes[i];	
			}

			// scroll to top of tree if not loading incrementally
			if (!incremental) {
				// Scroll to top of tree - This fixes a bug where if a user scrolled to the bottom of a long list of links and then switched to a tab
				// with fewer links, the user sees links at the bottom getting removed one by one, with the tree scrolling upwards at a fast pace
				//if (linksTree.currentIndex > this.linkList.length) {				
					var boxobject = linksTree.boxObject;
					boxobject.QueryInterface(Components.interfaces.nsITreeBoxObject);
					boxobject.scrollToRow(0);
				//}				
			}

			// Use custom background colour, if its been specified
			if (customBgColor) {
				customBgColorValue = this.prefs.getCharPref("bgcol");
				linksTreeChildren.style.backgroundColor = customBgColorValue;
			} else // ensure we show a white background - custom themes could have switched this to another colour making it hard to distinguish links of around the same colour as the background
				linksTreeChildren.style.backgroundColor = "#ffffff";
			
			// Add custom link colour to the external stylesheet (only way to style tree items)
			if (customLinkColor) {
				customLinkColorValue = this.prefs.getCharPref("linkcol");
				color = customLinkColorValue;
				propName = color.replace("#", "col");
			}
			
			// If loading incrementally, start where we left off - if not, start from the top, overwriting older links
			// Do not load incrementally if search tokens have been entered; as this causes the matches to appear multiple times in the list
			if (incremental && !this.searchTokens) {
				i = this.numLinksLoaded;
				numLinksLoaded = this.numLinksLoaded;
			} else {
				i = 0;
				numLinksLoaded = 0;
			}
			
			/*if ( (filterLinks = this.prefs.getBoolPref("filterListEnabled")) ) {
				filteredLinksList = this.prefs.getCharPref("filterListSites").split(";");
			}*/
			
			numTested = 0; // How many links in the current page have been tested
			
			treeLinks = [];
			k = 0; // Index into treeLinks array
			map = []; // provides a mapping between treelinks and linklist

			//  Add links to the tree
			for (; i < this.linkList.length; i++) {
				// Should we perform a search?
				if (this.searchTokens) {	
					// perform the search, adding everything that matches			
					match = true; // Add this link to the tree unless we have a reason not to
					for (j = 0; j < this.searchTokens.and.length; j++) {
						if (!this.linkList[i].text.toLowerCase().match(this.searchTokens.and[j]) && 
								(!this.linkList[i].url.toLowerCase().match(this.searchTokens.and[j]))) {
							match = false;
							break;
						}							
					}
					// filter out everything that matches terms to be excluded from the results
					for (j = 0; j < this.searchTokens.not.length; j++) {
						if (this.linkList[i].text.toLowerCase().match(this.searchTokens.not[j]) || // check data if exists
									(this.linkList[i].url.toLowerCase().match(this.searchTokens.not[j]))) {
								match = false;
								break;
						}							
					}
					//filter out anything that the user has set to be filtered
					/*if (filterLinks) { // Is the filter enabled?
						for (j = 0; j < this.searchTokens.not.length; j++) {
							if (this.linkList[i].text.toLowerCase().match(filteredLinksList[j]) || // check data if exists
									(this.linkList[i].url.toLowerCase().match(filteredLinksList[j]))) {
										match = false;
										break;
							}							
						}
					
					}*/
				} else {
					match = true;
				}					
							
				if (match) {
					treeLinks.push(i);
				}
			}
			
			if (this.sortOrder.order == 2 || this.sortOrder.order == 0)
				treeLinks = this.sortLinks(treeLinks);
			
			if (this.sortOrder.order == 2) { // Descending order 
				i = treeLinks.length - 1;
				stopValue = -1;
			} else  {
				i = 0;
				stopValue = treeLinks.length;
			}
				
			while (i != stopValue) {
				// Reuse any existing treeitems
				if (numLinksLoaded < this.numLinksLoaded) {
					item = linksTreeChildren.childNodes[numLinksLoaded];
					row = item.childNodes[0];	
					linkCell = row.childNodes[0];						
					urlCell = row.childNodes[1];	
					domainCell = row.childNodes[2];
					statusCell = row.childNodes[3];					
				} else { // No more existing treeitems to reuse, create new ones
					// Set the cell text with the text of child textnodes
					item = document.createElement("treeitem");
					row = document.createElement("treerow");						
					linkCell = document.createElement("treecell");		
					urlCell = document.createElement("treecell");	
					domainCell = document.createElement("treecell");
					statusCell = document.createElement("treecell");						
				}
				
				item.setAttribute('value', treeLinks[i]);

				linkCell.setAttribute("label", Linksidebar.linkList[treeLinks[i]].text); // set cell text

				// Set the color for the link
				if (!customLinkColor) {
					if ( Linksidebar.linkList[treeLinks[i]].color) {
						colorCorrection = 0;
						colorVals =  Linksidebar.linkList[treeLinks[i]].color.match(/\d+/g); // get the r,g,b values

						// Ensure that the colours are not too bright to be distinguished from the white list background		
						if (colorVals[0] > 180 && colorVals[1] > 180 ||
										colorVals[1] > 180 && colorVals[2] > 180 ||
											colorVals[2] > 180 && colorVals[0] > 180) {
							(colorVals[0] > colorVals[1])? (colorVals[0] > colorVals[2])? colorCorrection = colorVals[0] - 180: colorCorrection = colorVals[2] - 180 
															: (colorVals[1] > colorVals[2])? colorCorrection = colorVals[1] - 180: colorCorrection = colorVals[2] - 180;
						} else if (colorVals[0] > 238) {  
							colorVals[0] = 238;
						} else if (colorVals[1] > 238) {
							colorVals[1] = 238;
						} else if (colorVals[2] > 238) {
							colorVals[2] = 238;
						}
						if (colorCorrection) {	
							colorVals[0] -= colorCorrection;
							colorVals[1] -= colorCorrection;
							colorVals[2] -= colorCorrection;
						}
					} else {
						// set defaults
							colorVals[0] = colorVals[1] = 0;
							colorVals[2] = 238;
					}
						color = "rgb(" + colorVals[0] + ", " +  colorVals[1] + ", " + colorVals[2] + ")";
						propName = "col" + colorVals[0] + colorVals[1] + colorVals[2];	 // Add a property name for styling. Property name is col + rgb values (ex: col00238)
				}

				//Check if we've already added the rule to the stylesheet
				for (j = 0; j < colorRules.length; j++) {
					if (colorRules[j] == propName)
						break;
				} 
				// If we've not added the rule, add it now
				if (colorRules.length == 0 || j >= colorRules.length) {
					styleSheet.insertRule('treechildren::-moz-tree-cell-text(' + propName + ') { color:' + color + '}', numRules); // add color rule to stylesheet
					colorRules[numRules] = propName;
					numRules++;
				}
			
				linkCell.setAttribute("properties", propName + " " + ( Linksidebar.linkList[treeLinks[i]].fontWeight?  Linksidebar.linkList[treeLinks[i]].fontWeight : "")); // set style

				urlCell.setAttribute("label",  Linksidebar.linkList[treeLinks[i]].url);
				
				domainCell.setAttribute("label",  Linksidebar.linkList[treeLinks[i]].domain); //add domain to the tree	

				// Set the status of the link;
				if ((testIndex = this.testedLinks.indexOfUrl( Linksidebar.linkList[treeLinks[i]].url)) > -1) {
					numTested++;
					if (this.testedLinks[testIndex].statusColor != 0)
						statusCell.setAttribute("properties", "status_" + this.testedLinks[testIndex].statusColor);
					if (this.prefs.getCharPref('showStatus') == "text") {
						if (this.testedLinks[testIndex].statusColor == 2)
							statusCell.setAttribute("label", this.testedLinks[testIndex].testTime - this.testedLinks[testIndex].startTime + " " + bundle.getString('milliseconds'));
						else if (this.testedLinks[testIndex].statusColor == 4 || this.testedLinks[testIndex].statusColor == 6)
							statusCell.setAttribute("label", this.testedLinks[testIndex].status);
						else if (this.testedLinks[testIndex].statusColor == 7)
							statusCell.setAttribute("label", bundle.getString('timeOut'));
						else if (this.testedLinks[testIndex].statusColor == 9)
							statusCell.setAttribute("label", bundle.getString('testing'));
						else if (this.testedLinks[testIndex].statusColor == 8)
							statusCell.setAttribute("label", bundle.getString('unsupportedLinkType'));
						else
							statusCell.removeAttribute("label");
					} else
						statusCell.removeAttribute("label");
				} else {
					statusCell.setAttribute("properties", "status_default");
					statusCell.removeAttribute("label");
				}
				
				if (numLinksLoaded >= this.numLinksLoaded) {
				
					row.appendChild(linkCell); 
					
					row.appendChild(urlCell); 
					
					row.appendChild(domainCell);
					
					row.appendChild(statusCell);							

					item.appendChild(row);						

					linksTreeChildren.appendChild(item); //Add the treeitem to the treechildren element of this tree
				}
				numLinksLoaded++;
				
			if (this.sortOrder.order == 2)
				i--;
			else 
				i++;
			}
			for (; numLinksLoaded < this.numLinksLoaded; numLinksLoaded++) {
				linksTreeChildren.removeChild(linksTreeChildren.lastChild);
			}

			this.numLinksLoaded = linksTree.view.rowCount;
		
			numLinksLabel = document.getElementById('linksidebar-num-links');
			numLinksLabel.value = this.numLinksLoaded + " " + bundle.getString("linkCount");
			
			if (numTested > 0)
				this.hasTested = true;
			else
				this.hasTested = false;
		} catch (e) {
			throw ("linksidebar.addTree()\n" + e);
		}
	},	
	
	/* Searches through the current window and all frames for any hyperlinks and stores them in the linkList Array*/
	getLinks: function()
	{
		try {
			var i, j;
			var temp;
			var url;
			var text;
			var color;
			var fontWeight;
			var style;
			var customLinkColor;
			var re = /^([a-zA-Z0-9]*\:\/*)*(w{3}\.)?([^\/\?]*)/; // regular expression to extract the protocol type and domain of  a url			
			var result; // result of the Reg Exp evaluation
			var dupeType = Linksidebar.prefs.getIntPref("duplicatesType");
			var showDuplicates = Linksidebar.prefs.getIntPref("showDuplicates");
			
			var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
				.getInterface(Components.interfaces.nsIWebNavigation)
				.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
				.rootTreeItem
				.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
				.getInterface(Components.interfaces.nsIDOMWindow);
				
			this.page.title = mainWindow.content.document.title;
			this.page.url = mainWindow.content.document.location.href;
	
			function getTextForNode(node)
			{
				var text;
				if (node.hasAttribute('title')) {
					text = node.getAttribute('title');				
				} 

				// If there was no title attribute, or if there was an empty title attribute, get text under the link
				if (!text){ 
					text = gatherTextUnder(node);
				}
				return text;
			}
			
			function pushLink(link, showDuplicates, dupeType) {
				var i;
				
				
				if (! showDuplicates) {
					Linksidebar.linkList.push(link);
					return;
				}
				
				for (i = 0; i < Linksidebar.linkList.length; i++) {
						if (dupeType == 0) {
							if (Linksidebar.linkList[i].url == link.url)
								return;
						} else if (dupeType == 1) {
							if (Linksidebar.linkList[i].text == link.text)
								return;
						} else if (dupeType == 2) {
							if (Linksidebar.linkList[i].url == link.url && Linksidebar.linkList[i].text == link.text)
								return;
						} else {
							throw ("getLinks: Unknown duplicate link type");
						}
				}
				Linksidebar.linkList.push(link);	
			}

			this.linkList.splice(0);		// clear any links in the list

			customLinkColor = this.prefs.getBoolPref("customLinkcol");
			
			/* Get all links in current window... */
			temp = window.content.document.getElementsByTagName('a');
		
			/* ...and add them to the array of links */
			for (i = 0; i < temp.length; i++) {
				text = url = "";
				
				if (temp[i].hasAttribute("href"))	
					url = temp[i].href;
				else
					continue; // Ensure we don't add <a> tags without an href attribute
					
				// Get the style properties for the hyperlink
				if (!customLinkColor) {
					style = window.content.document.defaultView.getComputedStyle(temp[i],null);
					color = style.getPropertyValue('color');
					fontWeight = style.getPropertyValue('font-weight');
								
					if (fontWeight == "bold" || fontWeight > 400)
						fontWeight = "bold";
					else
						fontWeight = "";
				} else {
					color = fontWeight = "";
				}
				
				text = getTextForNode(temp[i]);
				
				if (!text) {
					text = url;
				}
				
				result = re.exec(url); // get the domain of this link
					
				pushLink( { a: temp[i],
							text: text,
							url: url,
							domain: result[3],										
							color: color,
							fontWeight: fontWeight }, showDuplicates, dupeType );						
			}

			/* Check if the window has any frames (particularly relevant in today's AJAX environment, don't you think?) */
			if (window.content.frames !== null) {
		    		for (i = 0; i < window.content.frames.length; i++) {
		        	
					if (window.content.frames[i].document) {					
						// Get all hyperlinks, add them to the array
						temp = window.content.frames[i].document.getElementsByTagName('a');				
						for (j = 0; j < temp.length; j++) {
							text = url = "";
							
							if (temp[j].hasAttribute("href"))	
								url = temp[j].href;
							else
								continue; // Ensure we don't add <a> tags without an href attribute
							
							if (!customLinkColor) {
								style = window.content.document.defaultView.getComputedStyle(temp[j],null);
								color = style.getPropertyValue('color');
								fontWeight = style.getPropertyValue('font-weight');
								
								if (fontWeight == "bold" || fontWeight > 400)
									fontWeight = "bold";
								else
									fontWeight = "";
							} else {
								color = fontWeight = "";
							}
							
							text = getTextForNode(temp[j]);
							
							if (!text) {
								text = url;
							}
							
							result = re.exec(url); // get the domain of this link
							
							pushLink( {	a: temp[j],
										text: text,
										url: url,
										domain: result[3],													
										color: color,													
										fontWeight: fontWeight }, showDuplicates, dupeType );	
						}
					}
				}
			}			
		} catch(e) {
			throw ("linksidebar.getLinks()\n" + e);
		}//alert(this.linkList.length);
	},	
	
	/* Breaks the search terms in the searchbox into a series of tokens and stores it in the searchTokens variable, and rebuilds the tree */
	search: function()
	{
		var linkSearchTextbox = document.getElementById('search-links-in-list');
		
		/* My crappy function to tokenise a string, takes a string, tokenises it and returns an array of strings(the tokens). Tokens are any word (space separated) *
		 *or any phrase (enclosed in quotes).If anyone can think of a better way to accomlish this, please do let me know							        */
		function tokenise(s)
		{
			var str = { and:[], not:[] };
			var i, j = 0;
			var tmp;
			var addTo;
			var endTokenChar;
			for (i = 0; i < s.length;i++) {
				tmp = "";
				if (s[i] == '-' && s[i+1] != ' ') {
					addTo = 'not'; 
					i++;
				}else
					addTo = 'and';
					
				if (s[i] == '"') {
					endTokenChar = '"';
					i++;
				} else
					endTokenChar = ' ';
				
				for (;i < s.length && s[i] != endTokenChar; i++) {
					tmp += s[i];				
				}

				if (tmp && /[^\t\n\r ]/.test(tmp)) {
						(addTo == 'not')? str.not.push(tmp) : str.and.push(tmp);
				}				
			}					
			return str;			
		}

		if (!linkSearchTextbox) {
			throw ("Linksidebar: search: error: Could not get textbox.");
		}
		
		if (linkSearchTextbox.value == "")
			this.searchTokens = "";
		else
			this.searchTokens = tokenise(linkSearchTextbox.value.toLowerCase());

		this.showTree();
	},
	
	/* Deselects whatever is selected in the tree */
	clearTreeSelection: function()
	{
		var tree;
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: openLink: error: could not get links tree from sidebar");
		
		// Select the first link - Mozilla leavs an irritating border around the last selected link after clearing the selection. 
		//This ensures the border doesn't show up in the middle of the list.		
		tree.view.selection.select(0);
		tree.view.selection.clearSelection();
	},
		
	/* Select all links in the tree */
	selectAll: function()
	{
		var tree;
		
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: selectAll: error: could not get links tree from sidebar");
			
		tree.view.selection.rangedSelect(0, tree.view.rowCount - 1, false);	
	},
	
	invertSelection: function()
	{
		var tree;
		
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: invertSelection: error: could not get links tree from sidebar");
		
		/* The tree.view.selection.invertSelection() function has not been implemented yet in Firefox :-( */

		var start = {};
		var end = {};
		var rangeCount = tree.view.selection.getRangeCount();
		var ranges = [];
		
		for (i = 0; i < rangeCount; i++) {
			tree.view.selection.getRangeAt(i, start, end);
			ranges.push({"start": start.value, "end": end.value});
		}
		var startPos = 0;

		for (i = 0; i < ranges.length; i++) {			
			if (startPos <= ranges[i].start - 1) // Don't want trouble if the first item is selected
				tree.view.selection.rangedSelect(startPos, ranges[i].start - 1, true);
			tree.view.selection.clearRange(ranges[i].start, ranges[i].end);
			startPos = ranges[i].end + 1;
		}
		
		if (startPos <= tree.view.rowCount - 1)
			tree.view.selection.rangedSelect(startPos, tree.view.rowCount - 1, true);

	},
	
	/* Updates the statusbar when the user moves the mouse over a link in the rtree */
	handleTreeMouseMove: function(event)
	{
		var tree;
		var tbo;
		var cellText;
		var row = { }, col = { }, obj = { };
		
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("Linksidebar: handleTreeMouseMove: error: could not get tree");
		
		tree.focus();
		
		if (event.target.localName != "treechildren")
			return;

		tbo = tree.treeBoxObject;

		tbo.getCellAt(event.clientX, event.clientY, row, col, obj);

		// row.value is -1 when the mouse is hovering an empty area within the tree.
		// To avoid showing a URL from a previously hovered node,
		// for a currently hovered non-url node, we must clear the URL from the
		// status bar in these cases.
		if (row.value != -1) {
			cellText = tree.view.getCellText(row.value, tree.columns.getNamedColumn('linksidebar-linkUrl'));
			window.top.XULBrowserWindow.setOverLink(cellText, null);
		}
		else
			window.top.XULBrowserWindow.setOverLink("", null);;	
	},	
	
	handleTreeClick: function(event)
	{
		var tree;
		var currentUrl;
		var tbo;
		var clickAction;	// Action to take when user clicks on treeitem
		var row = { }, col = { }, obj = { };
		var whereToOpen;
		
		//Do not handle context-clicks on tree
		if (event.button == 2)
			return;

		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: handleTreeClick: error: could not get links tree from sidebar");
		
		//This check is needed to prevent the first link in the page from loading if a user clicks on a column header
		tbo = tree.treeBoxObject;

		tbo.getCellAt(event.clientX, event.clientY, row, col, obj);
		
		if (row.value == -1) {
			this.clearTreeSelection();
			return;		
		}
		currentUrl = tree.view.getCellText(row.value, tree.columns.getNamedColumn('linksidebar-linkUrl'));
		
		if (!currentUrl)
			throw ("Linksidebar: handleTreeClick: could not retrieve url");
		
		// Check for middle-clicks/double-clicks
		if (event.button == 1) {
			// Hack: Firefox 3 reverses the default middle-click action for clicks in the sidebar - Shift+middle click opens in background, middle click in foreground
			// This reverses this behaviour to open the link in the background for middle clicks and in the foreground for shift+middle clicks
			whereToOpen = whereToOpenLink(event);
			if (whereToOpen == "tab")
				whereToOpen = "tabshifted";
			else if (whereToOpen == "tabshifted")
				whereToOpen = "tab";
			// End hack
			openUILinkIn(currentUrl, whereToOpen);
			return;
		}
		
		// check if the ctrl/shift key is pressed. If so, ignore this event (Unless it was a middle-click, in which case we process as normal above
		if (event.ctrlKey || event.shiftKey)
			return;

		tree.view.selection.select(row.value, false); // Deselect whatever is selected in the tree and select whaterver was clicked on
		
		var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
		                   .getInterface(Components.interfaces.nsIWebNavigation)
		                   .QueryInterface(Components.interfaces.nsIDocShellTreeItem)
		                   .rootTreeItem
		                   .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
		                   .getInterface(Components.interfaces.nsIDOMWindow);
		clickAction = this.prefs.getCharPref("clkaction");
		switch (clickAction) {
			case "0": // Open in new tab
				mainWindow.getBrowser().addTab(currentUrl);
			break;
			case "1": // Open in current tab
				openUILink(currentUrl, event, false, true);
			break;
			case "2": // Open in new window		   
				window.openDialog(getBrowserURL(), "_blank",
                        "chrome,all,dialog=no", currentUrl);
			break;
			case "3": // Copy link location
				this.copySelectedUrls();
			break;
			case "5": // Highlight link in document
				this.showInPage();
			break;
			default: // Activated for case 4, do nothing		
			break;
		}
	},
		
	/* Opens all selected links in new tabs or in new windows. If nothing selected, does nothing*/
	openSelectedLinks: function(where)
	{
		var i, j;
		var tree;
		var currentUrl;
		var rangeCount;
		var start = {};
		var end = {};
		var urls = [];
		var result;
	
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: openLink: error: could not get links tree from sidebar");			
		
		result = PlacesUIUtils._confirmOpenInTabs (tree.view.selection.count);		
		if (!result)
			return;
		
		var rangeCount = tree.view.selection.getRangeCount();
		for (i = 0; i < rangeCount; i++) {
			tree.view.selection.getRangeAt(i, start, end);
			for (j = start.value; j <= end.value; j++) {
				currentUrl = tree.view.getCellText(j, tree.columns.getNamedColumn('linksidebar-linkUrl'));
				if (currentUrl)
					urls.push(currentUrl);
				else
					throw ("Linksidebar: openSelectedLinks: could not get url to open from position " + j);
			}
		}
		if (where == "window") {
			window.openDialog(getBrowserURL(), "_blank",
                        "chrome,all,dialog=no", urls.join("|"));
			return;
		} else if (where == "tab") {
		var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIWebNavigation)
						.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
						.rootTreeItem
						.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIDOMWindow);
		mainWindow.getBrowser().loadTabs(urls, true, false);
		} else if (where == "current") {
		var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
				.getInterface(Components.interfaces.nsIWebNavigation)
				.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
				.rootTreeItem
				.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
				.getInterface(Components.interfaces.nsIDOMWindow);
		mainWindow.getBrowser().loadTabs(urls, true, true);
		}
	},
	
	/* Open all in tabs: Opens all links in the tree in tabs */
	openAllLinks: function()
	{
		var i;
		var tree;
		var currentUrl;
		var result;
		var urls = [];
		
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: openLink: error: could not get links tree from sidebar");	
			
		result = PlacesUIUtils._confirmOpenInTabs (tree.view.rowCount);	
		if (!result)
			return;
		
		for (i = 0; i < tree.view.rowCount; i++) {
			currentUrl = tree.view.getCellText(i, tree.columns.getNamedColumn('linksidebar-linkUrl'));
			if (currentUrl)
				urls.push(currentUrl);
			else
				throw ("Linksidebar: openSelectedLinks: could not get url to open from position " + j);
		}	
		var mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIWebNavigation)
						.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
						.rootTreeItem
						.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
						.getInterface(Components.interfaces.nsIDOMWindow);
		mainWindow.getBrowser().loadTabs(urls, true, false);
	},
	
	/* Enables/disables items on the context menu, depending on where the event originated */
	fixPopup: function(event)
	{
		var menuItem;
		var tree = document.getElementById('list-of-links');

		if (!tree)
			throw ("linksidebar: openLink: error: could not get links tree from sidebar");
			
		var tbo = tree.treeBoxObject;
		var row = { }, col = { }, obj = { };
		
		tbo.getCellAt(event.clientX, event.clientY, row, col, obj);
		
		/* Disable the reload links option if the links are currently locked */
		if (this.linksLocked) {
			menuItem = document.getElementById('linksidebar-context-reload');
			menuItem.setAttribute("disabled","true");
		} else {
			menuItem = document.getElementById('linksidebar-context-reload');
			menuItem.setAttribute("disabled","false");
		}
		
		// Disable the Test All links option only if there are no links in the tree
		if (this.numLinksLoaded > 0) {
			menuItem = document.getElementById('linksidebar-context_testAll');
			menuItem.setAttribute("disabled","false");
		} else {
			menuItem = document.getElementById('linksidebar-context_testAll');
			menuItem.setAttribute("disabled","true");
		}
		
		// Disable the select all and invert selection options if there are no links in the tree
		if (this.numLinksLoaded > 0) {
			menuItem = document.getElementById('linksidebar-context_selectAll');
			menuItem.setAttribute("disabled","false");
			menuItem = document.getElementById('linksidebar-context_invertSelection');
			menuItem.setAttribute("disabled","false");
			menuItem = document.getElementById('linksidebar-context_deselect');
			menuItem.setAttribute("disabled","false");
		} else {
			menuItem = document.getElementById('linksidebar-context_selectAll');
			menuItem.setAttribute("disabled","true");
			menuItem = document.getElementById('linksidebar-context_invertSelection');
			menuItem.setAttribute("disabled","true");
			menuItem = document.getElementById('linksidebar-context_deselect');
			menuItem.setAttribute("disabled","true");			
		}
		
		// Disable the Remove Highlights option if nothing is highlighted
		if (this.overlayLinks.length <= 0) {
			menuItem = document.getElementById('linksidebar-un_highlight');
			menuItem.setAttribute("disabled","true");	
		} else {
			menuItem = document.getElementById('linksidebar-un_highlight');
			menuItem.setAttribute("disabled","false");		
		}	
		
		if (tree.view.selection.count > 0) {	
		
			menuItem = document.getElementById('linksidebar-context_testLink');
			menuItem.setAttribute("disabled","false");
			menuItem = document.getElementById('linksidebar-highlight');
			if (this.linksLocked)
				menuItem.setAttribute("disabled","true");
			else
				menuItem.setAttribute("disabled","false");
			
			// show all		
			menuItem = document.getElementById('linksidebar-context_open');
			menuItem.setAttribute("disabled","false");
			menuItem = document.getElementById('linksidebar-context_open:newwindow');
			menuItem.setAttribute("disabled","false");
			menuItem = document.getElementById('linksidebar-context_open:newtab');
			menuItem.setAttribute("disabled","false");	
			menuItem = document.getElementById('linksidebar-context-copylink');
			menuItem.setAttribute("disabled","false");
			menuItem = document.getElementById('linksidebar-properties');
			menuItem.setAttribute("disabled","false");
			// disable the 'add bookmark' option if more than one link is selected
			menuItem = document.getElementById('linksidebar-addBookmarkContextItem');
			if (tree.view.selection.count < 2) {				
				menuItem.setAttribute("disabled","false");
			} else {
				menuItem.setAttribute("disabled","true");
			}
			
		} else {
			menuItem = document.getElementById('linksidebar-context_testLink');
			menuItem.setAttribute("disabled","true");
			menuItem = document.getElementById('linksidebar-highlight');
			menuItem.setAttribute("disabled","true");
			
			
			// hide all
			menuItem = document.getElementById('linksidebar-context_open');
			menuItem.setAttribute("disabled","true");
			menuItem = document.getElementById('linksidebar-context_open:newwindow');
			menuItem.setAttribute("disabled","true");		
			menuItem = document.getElementById('linksidebar-context_open:newtab');
			menuItem.setAttribute("disabled","true");		
			menuItem = document.getElementById('linksidebar-addBookmarkContextItem');
			menuItem.setAttribute("disabled","true");
			menuItem = document.getElementById('linksidebar-context-copylink');
			menuItem.setAttribute("disabled","true");
			menuItem = document.getElementById('linksidebar-properties');
			menuItem.setAttribute("disabled","true");
		}	

			// Highlight tested
			menuItem = document.getElementById('linksidebar-context_highlightTested');
			if (this.hasTested) {
				if (this.linksLocked)
					menuItem.setAttribute("disabled","true");
				else
					menuItem.setAttribute("disabled","false");
			} else {
				menuItem.setAttribute("disabled","true");
			}
	},
	
	/* copySelectedUrls: copies urls of all selected links to the clipboard, one on each line. If nothing selected, does nothing. Inputs: none Return: none */
	copySelectedUrls: function()
	{
		var i, j;
		var tree;
		var currentUrl;
		var rangeCount;
		var start = {};
		var end = {};
		var urlList = "";
	
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: openLink: error: could not get links tree from sidebar");
			
		if (tree.view.selection == -1)
			return;

		rangeCount = tree.view.selection.getRangeCount();
		for (i = 0; i < rangeCount; i++) {
			tree.view.selection.getRangeAt(i, start, end);
			for (j = start.value; j <= end.value; j++) {
				currentUrl = tree.view.getCellText(j, tree.columns.getNamedColumn('linksidebar-linkUrl'));
				if (currentUrl)
					urlList += currentUrl + "\n";
				else
					throw ("Linksidebar: copySelectedUrls: error: could not get url to copy at position " + j);
			}
		}	
		
		if (urlList) {
			const gClipboardHelper = Components.classes["@mozilla.org/widget/clipboardhelper;1"].
                                    getService(Components.interfaces.nsIClipboardHelper);
			gClipboardHelper.copyString(urlList);
		}	
	},
	
	/* Sets the text in the textbox to "Search Links" if the search box is empty */
	textboxFocus: function(focus)
	{
		var linkSearchTextbox;
		var bundle = document.getElementById('linksidebar-stringBundle');
		
		linkSearchTextbox = document.getElementById('search-links-in-list');
		
		// Determine the FF version and take action
		var appInfo = Components.classes["@mozilla.org/xre/app-info;1"]
			                        .getService(Components.interfaces.nsIXULAppInfo);
		var versionChecker = Components.classes["@mozilla.org/xpcom/version-comparator;1"]
			                        .getService(Components.interfaces.nsIVersionComparator);
		if(versionChecker.compare(appInfo.version, "3.5") >= 0) {
			this.clearTreeSelection();
			return;
		}
		if (!linkSearchTextbox) {
			throw ("Could not get textbox.");
		}
		
		if (focus) { // focus event
			if (linkSearchTextbox.value == bundle.getString('searchMsg')) {
				linkSearchTextbox.value = "";
				linkSearchTextbox.style.color = "#000000";
			}
		}
		else { // blur event 			
			if (linkSearchTextbox.value === "" || linkSearchTextbox.value === null) {
				linkSearchTextbox.value = bundle.getString('searchMsg');
				linkSearchTextbox.style.color = "#888888";
			}
		}
		this.clearTreeSelection();
	},
	
	addBookmark: function()
	{
		var tree;
		var bmsvc;
		var ios;
		var uri;
		var newBkmkId;
		var currentData;
		var currentUrl;
		
		tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: openLink: error: could not get links tree from sidebar");

		currentUrl = tree.view.getCellText(tree.currentIndex, tree.columns.getNamedColumn('linksidebar-linkUrl'));
		currentData = tree.view.getCellText(tree.currentIndex, tree.columns.getNamedColumn('linksidebar-linkName'));
		
		bmsvc = Components.classes["@mozilla.org/browser/nav-bookmarks-service;1"]
                      .getService(Components.interfaces.nsINavBookmarksService);

		ios = Components.classes["@mozilla.org/network/io-service;1"]
                    .getService(Components.interfaces.nsIIOService);
		uri = ios.newURI(currentUrl, null, null);
		if (!bmsvc.isBookmarked(uri)) {
			PlacesUIUtils.showMinimalAddBookmarkUI(uri, currentData);
		}	
	},
	
	/* Does what it says */
	toggleLinkLock: function()
	{
		/* If we're unlocking, cancel any running test on these links */
		if (this.linksLocked && this.page.currentTest)
			this.cancelTest(false);

		this.linksLocked = !this.linksLocked;
		
		/* If we are unlocking, reload the linklist */
		if (!this.linksLocked) {
			this.getLinks();
			this.showTree();			
		}
	},
	
	showPrefs:function()
	{
		window.openDialog('chrome://linksidebar/content/prefs.xul','linksidebar-prefs','centerscreen, chrome, resizable, modal');
	},
	
	sortTree: function(column, event)
	{
		var tree;
		var order;
		var orders = ['descending', 'natural', 'ascending'];
		
		// Handle only left-clicks, ignore right & middle clicks
		if (event.button == 2 || event.button == 1)
			return;
			
		order = column.getAttribute('sortDirection') == 'ascending' ? 2 :
					column.getAttribute('sortDirection') == 'descending' ? 0 : 1;
		
		order = (order + 1) % 3;
		
		// Reset sort direction for all columns (Firefox does not do this automatically for non-template trees)
		document.getElementById('linksidebar-linkName').setAttribute('sortDirection', 'natural');
		document.getElementById('linksidebar-linkUrl').setAttribute('sortDirection', 'natural');
		document.getElementById('linksidebar-linkDomain').setAttribute('sortDirection', 'natural');
		document.getElementById('linksidebar-linkStatus').setAttribute('sortDirection', 'natural');
		
		// Set sort direction for the sorted column
		column.setAttribute('sortDirection', orders[order]);
		
		// Get all other columns
		// Set their attributes to natural
		
		this.sortOrder = {order: order, field: column.id};
		this.showTree();
	},
	
	/* This function checks all selected links on the webpage by sending http head requests to the servers and analysing the response *
	 * If the argument all is true, all links are checked. If not, only selected links are checked							    */
	testLinks: function(collect)
	{
		try{
			var links = [];
			var tree;
			var url;
			var rangeCount;
			var i, j;
			var urlTreeCol;
			var start = {};
			var end = {};
			
			// show the status treecol if not shown already
			tree = document.getElementById('list-of-links');					
			urlTreeCol = tree.columns.getNamedColumn('linksidebar-linkUrl');
			// iterate over all links; if the url is displayed anywhere, change its status
			
			if (!tree)
				throw ("linksidebar: testLinks: error: could not get links tree from sidebar");
			if (!urlTreeCol)
				throw ("linksidebar: testLinks: error: could not get links urls from sidebar");			

			if (tree.view.selection == -1)
				return;
				
			if (collect == 'all') {
				for (i = 0; i < tree.view.rowCount; i++) { // gather all links
					url = tree.view.getCellText(i, urlTreeCol);
					if (links.indexOf(url) > -1) // If we've already collected this link for testing, don't add it again (no duplicates)
						continue;
					links.push(url);
				}
			} else if (collect == 'selected') {
				rangeCount = tree.view.selection.getRangeCount();
				for (i = 0; i < rangeCount; i++) { // gather selected links
					tree.view.selection.getRangeAt(i, start, end);
					for (j = start.value; j <= end.value; j++) {
						url = tree.view.getCellText(j, urlTreeCol);
						if (links.indexOf(url) > -1) // ensure we add only unique links, no duplicates
							continue;
						links.push(url);
					}
				}				
			} else
				throw ("Unexpected argument: collect: " + collect + "Expected 'all' or 'selected'.");
			
			this.beginTest(links); // test collected links
		} catch (e) {
			throw ("Linksidebar.testLinks()\n" + e);
		}
	},
	
	/* beginTest - adds links to the testLinks array and begins testing them by spawning a new tester thread (if one is not already active) 	*
	 * Input: array of URLs to test																			*
	 * Output: none																						*
	 * 9:19 PM 9/18/2008, Varun Naik																			*/
	beginTest: function(links)
	{
		try {
			var maxThreads;	
			var mainThread;
			var i = 0;
			var statusCol;
			var name;
			var testedLinkIndex;
			var index; 		// Index of this test in the runningTests array
			
			var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
			.getService(Components.interfaces.nsIWindowMediator);
			var tabBrowser = wm.getEnumerator('navigator:browser').getNext().getBrowser();
			var currentTab = tabBrowser.selectedTab;
			
			// Check if there is already a test running on the links in the sidebar. If so, cancel it.
			if (this.linksLocked && this.page.currentTest) { // If a test is running on links locked in sidebar, cancel it
				this.cancelTest(false);
				this.page.currentTest = "";
			} else if (currentTab.hasAttribute("linksidebar-testing")) {// If links aren't locked, and a test is running on links in current tab, cancel it
				this.cancelTest(false);
			}

			mainThread = Components.classes["@mozilla.org/thread-manager;1"]
			                        .getService(Components.interfaces.nsIThreadManager)
			                        .currentThread;
									
			maxThreads = this.prefs.getCharPref("maxThreads");
			
			//Show the cancel tests button
			this.showCancelTestButton(true);
			
			// Show the status treecol if not visible already
			statusCol = document.getElementById('linksidebar-linkStatus');
			if (statusCol.hidden == true)
				statusCol.hidden = false;
			
			name = "test_" + new Date().getTime() + "_" + this.numLinksLoaded + "_" + this.runningTests.length;
				
			// Initialise test attributes: assign a unique name for this test and mark the test as started
			index = this.runningTests.push({"name": name,
											"run": true, "update": true});
			index--;			
			this.page.currentTest = name;
			
 			// attach attribute identifying this tab as one on which testing is being carried out  - useful if we want to check if the user closes the tab, needing us to stop the test
			// attribute is "linksidebar-testing" with the value as the name of this test
			if (!this.linksLocked)
				currentTab.setAttribute("linksidebar-testing", name);
			
			// Update icons to indicate which links will be tested
			while (i < links.length) {
				if ((testedLinkIndex = this.testedLinks.indexOfUrl(links[i])) > -1) {
					this.testedLinks[testedLinkIndex].statusColor = 0;
					this.testedLinks[testedLinkIndex].header = "";
					this.testedLinks[testedLinkIndex].status = "";
					this.testedLinks[testedLinkIndex].testTime = 0;
				}this.testedLinks.push({href: links[i], testedTime: null, status: null, header: null, statusColor: 0});
				this.updateListDisplay(links[i]);
				i++;
			}
			
			i = 0;
			
			// Note about the test: this.runningTests[(this.name == this.runningTests[index].name)? index : index = this.runningTests.findByName(test.name)].run == true
			// Check if this test should run. If the index has changed since we last saw it (name at index != our name), due to another tester finishing and getting spliced out, then find the new position for this test in the array and store it for future reference.
			// If the index has not changed (name at index = our name) then use the index as is.		
			

			// If there are too many threads running already, wait till a thread finishes testing
			while (i < links.length && 	 
					this.runningTests[(name == this.runningTests[index].name)? index : index = this.runningTests.findByName(name)].run == true  ) {
				// Wait for some threads to become free
				while (this.runningThreads >= maxThreads && 
						this.runningTests[(name == this.runningTests[index].name)? index : index = this.runningTests.findByName(name)].run == true)
					mainThread.processNextEvent(true);
					
				// Create threads to test the links till we hit the thread limit
				while (this.runningThreads < maxThreads &&
						this.runningTests[(name == this.runningTests[index].name)? index : index = this.runningTests.findByName(name)].run == true) {
					this.runningThreads++;					
					// Note that the argument to testLink must be specified as a parameter to setTimeout, otherwise the code won't work
					setTimeout (this.testLink,1,links[i++]);
					if (i == links.length)
						break;
				}
			}
			
			// If this test was cancelled, remove any pending-test icons from remaining links
			while (i < links.length) {
				if (this.runningTests[(name == this.runningTests[index].name)? index : index = this.runningTests.findByName(name)].update == true)
					this.updateListDisplay(links[i], true);
				if ((testedLinkIndex = this.testedLinks.indexOfUrl(links[i])) > -1) {					
					this.testedLinks.splice(testedLinkIndex, 1);				
				}
				i++;
			}
				
			//Testing over, remove from runningTests array
			this.runningTests.splice(this.runningTests.findByName(name), 1);
			this.page.currentTest = "";
			
			//Now, remove the attribute from the tab
			// Enumerate tabs till we've found the tab associated with this test
			for (i = 0; i < tabBrowser.mTabs.length; i++) {
				currentTab = tabBrowser.mTabs[i];
				
				if (currentTab.getAttribute('linksidebar-testing') === name) {
					// remove the attribute
					currentTab.removeAttribute('linksidebar-testing');
					break;
				}
			}			
			// note that the attribute may not always be found - for example, if the tab was closed - in this case, we quit silently
			
			//Hide cancel test button
			this.showCancelTestButton(false);			
		} catch (e) {
			throw ("Linksidebar.beginTest()\n" + e);
		}
	},
	
	/* Test a link and store the results of the test in the testedLinks array */
	testLink: function(url)
	{
		try {
		var timeoutId;
		var timeout;
		var req;
		var reqType;
		var re = /^http/;

		/* Evaluates http response, stores header and status in array and calls function to update list display *
		 * 2:11 AM 9/22/20082:11 AM 9/22/2008, Varun Naik						         */
		function evalLink(url, req, timeoutId)	
		{
			try {
				var statusColor;
				var testedLink = {};
				var testedLinkIndex = -1;
				
				// Record the time at which we started testing
				if (req.readyState == 1) {
					if ((testedLinkIndex = Linksidebar.testedLinks.indexOfUrl(url)) > -1) {
						Linksidebar.testedLinks[testedLinkIndex].startTime = new Date();
					} else
						throw ("evalLink: error: could not get index of tested link in array");
				}
				
				// Check if the request has completed. If not, return 
				if (req.readyState == 4 && req.status) {					
					// Clear the timeout since the request completed successfully
					if (typeof (timeoutId) != 'undefined')
						clearTimeout(timeoutId);					
						
					// Check if this is a timeout or if a reply was received
					if (req.status > 99 && req.status < 200) // reply
						statusColor = 1;		
					else if (req.status > 199 && req.status < 300)
						statusColor = 2;		
					else if (req.status > 299 && req.status < 400)
						statusColor = 3;		
					else if (req.status > 399 && req.status < 500)
						statusColor = 4;		
					else if (req.status > 499 && req.status < 600)
						statusColor = 5;		
					else
						statusColor = 6;
					
					// create an object holding all parameters of the tested link
					testedLink.testTime = new Date();
					testedLink.href = url;
					testedLink.header = req.getAllResponseHeaders();
					testedLink.status = req.status;										
					testedLink.statusColor = statusColor;					

					// If url is already in the testedLinks array, replace it. If not in the array, add it now
					if ((testedLinkIndex = Linksidebar.testedLinks.indexOfUrl(url)) > -1) {
						Linksidebar.testedLinks[testedLinkIndex].testTime = testedLink.testTime;
						Linksidebar.testedLinks[testedLinkIndex].statusColor = testedLink.statusColor;
						Linksidebar.testedLinks[testedLinkIndex].header = testedLink.header;
						Linksidebar.testedLinks[testedLinkIndex].status = testedLink.status;					
					} else
						throw ("evalLink: error: could not get index of tested link in array");
					
					Linksidebar.updateListDisplay(url);
					// Decrement the running threads count, as we're done with this thread
					Linksidebar.runningThreads--;
					return;
				}
			} catch (e) {
				if (typeof (req) != 'undefined')
					req.abort();
				clearTimeout(timeoutId);
				Linksidebar.runningThreads--;
			}				
		};
		
		function testEvent(url, type)
		{
			var testedLinkIndex;
			var startTime;

			var testedLink = {};
			if (type == 'timed out')
				testedLink.statusColor = 7;
			else if (type == 'not valid')
				testedLink.statusColor = 8;
			else if (type == 'testing')
				testedLink.statusColor = 9;
			testedLink.href = url;
			testedLink.testTime = new Date();
			// Url already present in tested Links array
			if ((testedLinkIndex = Linksidebar.testedLinks.indexOfUrl(url)) > -1) {
				Linksidebar.testedLinks[testedLinkIndex].testTime = testedLink.testTime;
				Linksidebar.testedLinks[testedLinkIndex].statusColor = testedLink.statusColor;
				Linksidebar.testedLinks[testedLinkIndex].header = "";
				Linksidebar.testedLinks[testedLinkIndex].status = "";
				Linksidebar.testedLinks[testedLinkIndex].startTime = "";
			} else 
				throw ("testEvent: error: could not get index into testedLinks array");
				
			Linksidebar.updateListDisplay(url);
			// If we aren't going to test the thread, decrement the number of running threads (as we're done testing this url)
			if (type != 'testing')
				Linksidebar.runningThreads--;
			return;		
		};
		
		// Test only if this a http link (javascript / ftp / file links may cause problems)
		if (re.test(url)) {			
			testEvent(url, 'testing'); // Show loading icon to indicate we're testing this link
			req = new XMLHttpRequest();
			timeout = Linksidebar.prefs.getIntPref("timeout");
			(timeout < 0)? timeout = 0: 1;
			
			reqType = Linksidebar.prefs.getCharPref("requestType");

			// abort request if it takes longer than the timeout specified
			timeoutId = setTimeout(function(){req.abort(url);testEvent(url, 'timed out');}, timeout);

			req.onreadystatechange = function(){ evalLink(url, req, timeoutId);}
			req.open(reqType, url, true);
			req.setRequestHeader("Content-Length", "0");
			req.send(null);
		} else 
			testEvent(url, 'not valid');
		} catch (e) {
			Linksidebar.runningThreads--;
			throw ("Linksidebar.testLink()\n" + e);
		}
	},
	
	/* Updates link status in the tree. Takes one of two arguments - If index is supplied, testing is finished and status is updated from the testedLinks array *
	 * If index is not supplied and url is supplied, testing of link is beginning - all occurences of the link have status updated to testing  */
	updateListDisplay: function(url, setDefault)
	{
		try {
			var tree;
			var linksTreeChildren;
			var urlCol;			
			var statusCell;
			var statusColor;
			var i;
			var testedLinkIndex;
			var statusText;
			var bundle = document.getElementById('linksidebar-stringBundle');
			var numTested = 0;
			
			tree = document.getElementById('list-of-links');
			urlCol = tree.columns.getNamedColumn('linksidebar-linkUrl');
			
			for (i = 0; i < tree.childNodes.length; i++) {
				if (tree.childNodes[i].tagName.toLowerCase() == 'treechildren') {
					linksTreeChildren = tree.childNodes[i];
					break;
				}
			}
			
			if (typeof (linksTreeChildren) == 'undefined')
				throw ("error: Linksidebar.updateListDisplay(): No links in tree.");
				
			if ((testedLinkIndex = this.testedLinks.indexOfUrl(url)) > -1) {
				statusColor = this.testedLinks[testedLinkIndex].statusColor;
				if (statusColor == 2)
					statusText = this.testedLinks[testedLinkIndex].testTime - this.testedLinks[testedLinkIndex].startTime + " " + bundle.getString('milliseconds');
				else if (statusColor == 4 || statusColor == 5)
					statusText = this.testedLinks[testedLinkIndex].status;
				else if (statusColor == 7)
					statusText = bundle.getString('timeOut');
				else if (statusColor == 9)
					statusText = bundle.getString('testing');
				else if (statusColor == 8)
					statusText = bundle.getString('unsupportedLinkType');
				else
					statusText = "";
			} else
				throw ("error: could not get index of link into testedLinks array!");

			// iterate over all links; if the url is displayed anywhere, change its status
			for (i = 0; i < tree.view.rowCount; i++) {
				if (tree.view.getCellText(i, urlCol) == url) {
					statusCell = linksTreeChildren.childNodes[i].firstChild.lastChild;
					statusCell.removeAttribute('properties');
					if (typeof (setDefault) != "undefined" && setDefault == true)
						statusCell.setAttribute('properties', 'status_default');
					else {
						statusCell.setAttribute('properties', 'status_' + statusColor);
						if (this.prefs.getCharPref('showStatus') == "text")
							statusCell.setAttribute('label', statusText);
						else
							statusCell.setAttribute('label', "");
						numTested++;	
					}					
				}
			}
			if (numTested > 0)
				Linksidebar.hasTested = true;
			else
				Linksidebar.hasTested = false;
		} catch (e) {
			throw ("Linksidebar.updateListDisplay()\n" + e);
		}
	},
	
	/* Cancel the test currently running on the selected tab */
	cancelTest: function(updateDisplay)
	{
		var index;
		var name;
		// Get the current tab
		var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
				.getService(Components.interfaces.nsIWindowMediator);
		var currentTab = wm.getEnumerator('navigator:browser').getNext().getBrowser().selectedTab;
		// If the links are locked, get the running test stored name stored in the page array
		if (this.linksLocked) {
			name = this.page.currentTest;
			index = this.runningTests.findByName(name);
			this.runningTests[index].run = false;
		}
		// Check if there's a test running on this tab
		else if ((name = currentTab.getAttribute("linksidebar-testing"))) {
			index = this.runningTests.findByName(name); // If there is a running test, mark it stopped
			this.runningTests[index].run = false;
			if (typeof (updateDisplay) != "undefined" && this.updateDisplay == false)
				this.runningTests[index].update = false;
		} else 
			throw ("Linksidebar.cancelTest(): Error: could not determine which test to cancel!");
	},
	
	/* Shows or hides the cancel test button	 */
 	showCancelTestButton: function(show)
	{
		var cancelButton = document.getElementById('linksidebar-cancel-test-button');
		if (show)
			cancelButton.removeAttribute('collapsed');			
		else
			cancelButton.setAttribute('collapsed', 'true');	
	},
	
	showProperties: function()
	{
		var tree;
		var currentUrl;
		var currentName;
		var currentDomain;
		var status;
		var header;
		var testedTime;
		var statusColor;
		var startTime;
		var re = /^([a-zA-Z0-9]*\:\/*)*(w{3}\.)?([^\/\?]*)/;
		var linkCount = 0;
		var domainCount = 0;
		var testedLinkIndex;
		var i;
		
		tree = document.getElementById('list-of-links');

		currentUrl = tree.view.getCellText(tree.currentIndex, tree.columns.getNamedColumn('linksidebar-linkUrl'));
		currentName = tree.view.getCellText(tree.currentIndex, tree.columns.getNamedColumn('linksidebar-linkName'));
		currentDomain = tree.view.getCellText(tree.currentIndex, tree.columns.getNamedColumn('linksidebar-linkDomain'));

		if ((testedLinkIndex = this.testedLinks.indexOfUrl(currentUrl)) > -1) {
			status = this.testedLinks[testedLinkIndex].status;
			header = this.testedLinks[testedLinkIndex].header;
			testedTime = this.testedLinks[testedLinkIndex].testTime;
			statusColor = this.testedLinks[testedLinkIndex].statusColor;
			startTime = this.testedLinks[testedLinkIndex].startTime;
		}
		for (i = 0; i < this.linkList.length; i++) {
			if (this.linkList[i].url === currentUrl) {
				linkCount++;
				domainCount++;
			}
			else if (re.exec(this.linkList[i].url)[3] === currentDomain) {
				domainCount++;
			}
		}
		window.openDialog('chrome://linksidebar/content/properties.xul','','centerscreen, chrome, resizable, modal',
		this.page.url, this.page.title, currentUrl, currentName, currentDomain, linkCount, domainCount, status, header, testedTime, statusColor, startTime);
	},
	
	popoutSidebar: function() {
		
	},
	
	showInPage: function()
	{	
		if (this.linksLocked)
			return;
		
		var tree = document.getElementById('list-of-links');
		var i;
		var rangeCount;
		var start = {};
		var end = {};
		var index;
		
		if (!tree)
			throw ("linksidebar: showInPage: error: could not get links tree from sidebar");
			
		this.removeLinkOverlay();
		
		// Get all selected links
		var rangeCount = tree.view.selection.getRangeCount();
		for (i = 0; i < rangeCount; i++) { // gather selected links
			tree.view.selection.getRangeAt(i, start, end);
			for (j = start.value; j <= end.value; j++) {
				item = tree.view.getItemAtIndex(j);
				index = item.getAttribute('value');
				this.overlayLinks.push({"a": this.linkList[index].a, "highlight": null, "color": null, "index": j});
			}
		}
		
		this.addLinkOverlay();
	},
	
	addLinkOverlay: function() {
		if (this.overlayLinks.length <= 0)
			return;
		
		var i = 0;
		var win;
		var offsetParent;
		var added = 0;
		var scrollX = window.scrollX;
		var scrollY = window.scrollY;
		var top = left = height = width = 0;
		var coords = null;
		var hideTopBorder = false; // If a link is not visible on the page (hidden behind a javascript menu, for example),
		// we outline the item in the menu in red. However, if two consequtive items are to be highlighted, the top border of the second
		// element must be hidden because otherwise there will be a double border between them.
		
		var isVisible = function(elem) {
			if (elem.offsetWidth > 0 && elem.offsetHeight > 0) {
				var style = window.content.document.defaultView.getComputedStyle(elem, null);
				if (style.getPropertyValue('visibility') != 'hidden' && style.getPropertyValue('display') != 'none')
					return true;
			}		
			return false;
		};
		
		var findPos = function(elem) {
			var box = elem.getBoundingClientRect(), doc = elem.ownerDocument, body = doc.body, docElem = doc.documentElement,
	        clientTop = docElem.clientTop || body.clientTop || 0, 
			clientLeft = docElem.clientLeft || body.clientLeft || 0,
	        top  = box.top  + (self.pageYOffset || docElem.scrollTop  || body.scrollTop ) - clientTop,
            left = box.left + (self.pageXOffset || docElem.scrollLeft || body.scrollLeft) - clientLeft;
			bottom = box.bottom + (self.pageYOffset || docElem.scrollTop  || body.scrollTop ) - clientTop,
			right = box.right + (self.pageXOffset || docElem.scrollLeft || body.scrollLeft) - clientLeft;
	        return { top: top, left: left, bottom: bottom, right: right };
		};
				
		for (i = 0; i < this.overlayLinks.length; i++) {
			element = this.overlayLinks[i].a;
			
			if (this.overlayLinks[i].highlight != null) // We've already overlaid this element
				continue;
			
			if (! isVisible(element)) {		
				this.outlineTreeItem(this.overlayLinks[i].index, "notFound", hideTopBorder);
				hideTopBorder = true; // If link not visible, set this to true so if the next link is also not visible, it will be outlined without a top border to prevent double border between the two consequtive links
				continue;
			}
			hideTopBorder = false; // On the other hamd, if the next link is visible, reset this so the next not-found link is shown with a top border
	
			coords = findPos(element);
			top = coords.top;
			left = coords.left;
			right = coords.right;
			bottom = coords.bottom;
			height = element.offsetHeight;
			width = element.offsetWidth;	

			if (left + width > right) { // To catch inline links wrapped across multiple lines. In this case, the right may be < the left
				coords = findPos(element.parentNode);
				left = coords.left;
			} else if (top + height > bottom) { // Dunno if this will actually ever occur in a webpage, but if the above is possible maybe there are cases where this occurs as well?
				coords = findPos(element.parentNode);
				top = coords.top;
			}
			
			var highlight = element.ownerDocument.createElement('div');
			var style = 'float: left; position: absolute; top: ' + top + 'px; ';
			style += 'left: ' + left + 'px; ';
			style += 'height: ' + height + 'px;';
			style += 'width: ' + width + 'px; ';
			style += ' z-index: 2147483000; opacity: 0.5;';
			
			if (this.overlayLinks[i].color) { // These would be set when highlighting tested links
				style += "background-color: " + this.overlayLinks[i].color.highlight + "; ";
				style += "outline: " + this.overlayLinks[i].color.outline + " solid 2px; ";
			} else {
				style += "background-color: #3875d7;";
				style += "outline: #2A589E solid 2px";
			}
				
			highlight.setAttribute('style',  style);
			highlight.setAttribute('index', this.overlayLinks[i].index);
			
			element.ownerDocument.body.insertBefore(highlight, null);
			
			highlight.addEventListener('mouseover', Linksidebar.highlightMouseOver, false);
			element.addEventListener('mouseout', Linksidebar.highlightMouseOut, false);
			
			this.overlayLinks[i].highlight = highlight;
			added++;
		}
		if (added == 1)
			setTimeout(function() {Linksidebar.overlayLinks[0].highlight.scrollIntoView();}, 100); // Prevent the highlight getting cut-off at times
		Linksidebar.mouseOverHighlight = null;	
	},
	
	
	/* outlineTreeItem: Outlines a tree row in LinkSidebar with the specified style *
	 * Arguments:
	 *			index: Which tree item to outline
	 *			context: How to highlight it - choices are 'outline' and 'highlight'. Outline is used to highlight links not currently visible in the page. 
	 *																Highlight is used to colour links in the tree when mousing over them in the page.
	 *			hideTopBorder: Used to hide the top border in the case of two consequtive 'outline' links, since two consequitve links will have a double border between
	 *							them in the tree. Note that the caller is responsible for ensuring that two invisible links are indeed consequtive before setting this to true.
	 *							No checking is done in the function.
	 *			scrollIntoView: Whether or not to scroll the item into view in the tree, if it is not currently visible. Typically used only for 'highlight' links.
	 * Returns: Nothing
	 * Side-effects: None
	 */
	outlineTreeItem: function(index, context, hideTopBorder, scrollIntoView) {
		var tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: outlineTreeItem: error: could not get links tree from sidebar");
			
		var item = tree.view.getItemAtIndex(index);		
		
		if (context == "notFound") {
			if (hideTopBorder)
				properties = "notFoundHideTopBorder";
			else
				properties = "notFound";			
		} else if (context == "highlight") {
			properties = "highlight";
		}
		
		item.firstChild.setAttribute("properties", properties);
		
		if (scrollIntoView) {					
			var boxobject = tree.boxObject;
			boxobject.QueryInterface(Components.interfaces.nsITreeBoxObject);
			boxobject.ensureRowIsVisible(index);
		}
		
		if (this.outlinedTreeItems.indexOf(index) == -1) // Add this to the highlighted tree rows array if not already done
			this.outlinedTreeItems.push(index);		
	},
	
	removeOutlineFromTreeItem: function(index) {
		var tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: removeOutlineFromTreeItem: error: could not get links tree from sidebar");

		if (!tree.view) // Sometimes when closing Linksidebar, the tree would have already been destroyed - in which case the view would no longer exist.
			return false;
			
		var item = tree.view.getItemAtIndex(index);

		item.firstChild.removeAttribute('properties');
		
		var outlineIndex = this.outlinedTreeItems.indexOf(index);
		if(outlineIndex != -1)
			this.outlinedTreeItems.splice(outlineIndex, 1);
		return true;
	},
	
	clearAllOutlines: function(index) {
		for (i = 0; i < this.outlinedTreeItems.length; i++) {
			if (this.removeOutlineFromTreeItem(this.outlinedTreeItems[i]))
				i--; // Compensate for the item spliced out by the removeOutlines() function
		}
	},
	
	highlightMouseOver: function(evt) {
	
		// un-highlight any highlighted links
		if (Linksidebar.mouseOverHighlight)
			if (evt.target != Linksidebar.mouseOverHighlight)
				Linksidebar.highlightMouseOut();
			else
				return;
		
		Linksidebar.mouseOverHighlight = evt.target;		
		Linksidebar.mouseOverHighlight.style.visibility = 'hidden';
		var index = Linksidebar.mouseOverHighlight.getAttribute('index');
		
		Linksidebar.outlineTreeItem(index, "highlight", false, true);		// False = show top border, True = scroll into view
	},
	
	highlightMouseOut: function() {
		if (Linksidebar.mouseOverHighlight) {
			var index = Linksidebar.mouseOverHighlight.getAttribute('index');
			Linksidebar.removeOutlineFromTreeItem(index);
			Linksidebar.mouseOverHighlight.style.visibility = 'visible';
			Linksidebar.mouseOverHighlight = null;			
		}		
	},
	
	removeLinkOverlay: function() {
		if (this.overlayLinks.length <= 0)
			return;
			
		// un-highlight any highlighted links
		if (this.mouseOverHighlight)
			this.highlightMouseOut();
			
		// un-highlight highlighted tree rows
		this.clearAllOutlines();
			
		for (i = 0; i < this.overlayLinks.length; i++) {
			element = this.overlayLinks[i].a;
			if (this.overlayLinks[i].highlight != null) {
			
				this.overlayLinks[i].highlight.removeEventListener('mouseover', Linksidebar.highlightMouseOver, false);
				this.overlayLinks[i].a.removeEventListener('mouseout', Linksidebar.highlightMouseOut, false);	
				
				element.ownerDocument.body.removeChild(this.overlayLinks[i].highlight);
				
				this.overlayLinks[i].highlight = null;
			}
		}
		
		this.overlayLinks = [];	
	},
	
	highlightTestedLinks: function() {
		if (this.testedLinks.length <= 0)
			return;
			
		if (this.linksLocked)
			return;
			
		this.removeLinkOverlay();
		
		var highlight = null;
		var outline = null;
		
		var tree = document.getElementById('list-of-links');
		
		if (!tree)
			throw ("linksidebar: Highlight Tested :Links: error: could not get links tree from sidebar");
		
		// Get each link in the tree
		for (i = 0; i < tree.view.rowCount; i++) { // gather all links
			item = tree.view.getItemAtIndex(i);
			index = parseInt(item.getAttribute('value'));
			if ((testIndex = this.testedLinks.indexOfUrl(this.linkList[index].url)) > -1) {
				if (this.testedLinks[testIndex].statusColor == 2 || this.testedLinks[testIndex].statusColor == 3) {
						highlight = "#38d775"; // Green
						outline = "#38B675";
				} else if (this.testedLinks[testIndex].statusColor == 4 || this.testedLinks[testIndex].statusColor == 5 || this.testedLinks[testIndex].statusColor == 6) {
					highlight = "#c90000"; // Red
					outline = "#F80000";
				} else if (this.testedLinks[testIndex].statusColor == 7) {
					highlight = "#FFD800"; // Yellow
					outline = "#FFC200";
				}

			this.overlayLinks.push({"a": this.linkList[index].a, "highlight": null, "color": {"highlight" : highlight, "outline": outline}, "index": i});
			}		
		}
		this.addLinkOverlay();
	},
	
	drawBox: function() {
		// starts drawing a box on the webpage.
		
	},
	
	selectFromRegion: function() {
		// Select all links from the webpage in the region encompassed by the box
	},
};